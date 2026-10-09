import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, KeyboardEvent } from "react";

import type { AttachmentInfo, SessionState } from "../shared/ipc";
import { chatModeColor, chatModeLabel } from "../../../src/utils/chatMode";
import { COMMANDS, filterCommands, helpLines, splitCommandQuery } from "./commands";
import type { SlashCommand } from "./commands";
import { formatSize } from "./format";
import { localNote, toast } from "./store";

export interface ComposerActions {
  onOpenModel: () => void;
  onOpenAgent: () => void;
  onOpenResume: () => void;
  onOpenSkills: () => void;
  onChooseFolder: () => void;
}

// Same cap as main (fileHandling.ts MAX_FILE_SIZE, 50 MB), checked here first.
const MAX_PASTED_IMAGE_BYTES = 50 * 1024 * 1024;

// File list for "@" mentions. Main caches it (per folder, refreshed after a
// minute) and bounds the scan, so asking each time a mention starts is cheap.
async function loadMentionFiles(_folder: string | null): Promise<string[]> {
  const res = await window.dustm.mentionFiles();
  return res.ok && res.value ? res.value : [];
}

interface MenuEntry {
  key: string;
  label: string;
  detail?: string;
  /** Replaces text.slice(from, to) with `insert` when chosen. */
  apply: () => void;
}

export function Composer({
  session,
  actions,
}: {
  session: SessionState;
  actions: ComposerActions;
}) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // One submit at a time. Without it, key auto-repeat or a double Enter
  // submitted the same text several times before the first IPC call returned
  // (and each copy became a real, billed turn). See session.send for the
  // matching guard in main.
  const inFlight = useRef(false);
  const lastEscape = useRef(0);
  // When the Stop button appeared: it takes Send's place, so a click that was
  // meant for Send (a double-click, a click right after Enter) must not hit it.
  const stopShownAt = useRef(0);
  useEffect(() => {
    stopShownAt.current = session.busy ? Date.now() : 0;
  }, [session.busy, session.sessionKey]);
  // A first Escape in one conversation must not arm a stop in the next one.
  useEffect(() => {
    lastEscape.current = 0;
  }, [session.sessionKey]);
  const [stopHint, setStopHint] = useState(false);

  const agent = session.agents.find((a) => a.sId === session.agentId);
  const loading = session.loadingConversationId !== null;
  const canSend = !!session.folder && !!agent && !loading;

  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
    }
  }, [text]);

  useEffect(() => {
    if (!session.busy && !loading) {
      ref.current?.focus();
    }
  }, [session.conversationId, loading]);

  // ------------------------------------------------------------ menus

  const slashMatch = /^\/(\S*)$/.exec(text);
  const slashEntries = useMemo(
    () => (slashMatch ? filterCommands(slashMatch[1]) : []),
    [slashMatch?.[1]]
  );

  const before = text.slice(0, caret);
  const mentionMatch = /(^|\s)@([^\s@]*)$/.exec(before);
  const mentionQuery = mentionMatch ? mentionMatch[2] : null;
  const mentionStart = mentionMatch ? mentionMatch.index + mentionMatch[1].length : -1;

  // Re-asked each time a mention starts (the previous list stays on screen
  // meanwhile), so files created since are offered once main's cache expires.
  useEffect(() => {
    if (mentionQuery !== null) {
      void loadMentionFiles(session.folder).then((f) => {
        setFiles(f);
        setFilesLoaded(true);
      });
    }
  }, [mentionQuery !== null, session.folder]);

  // A different folder means a different file list.
  useEffect(() => {
    setFilesLoaded(false);
    setFiles([]);
  }, [session.folder]);

  // The sidebar's /btw button (and anything else) can put text in the box.
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const value = (e as CustomEvent<string>).detail;
      setText(value);
      setCaret(value.length);
      requestAnimationFrame(() => ref.current?.focus());
    };
    window.addEventListener("dustm:prefill", onPrefill);
    return () => window.removeEventListener("dustm:prefill", onPrefill);
  }, []);

  const mentionEntries = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return files.filter((f) => !q || f.toLowerCase().includes(q)).slice(0, 8);
  }, [files, mentionQuery]);

  const insertMention = (file: string) => {
    const next = `${text.slice(0, mentionStart)}@${file} ${text.slice(caret)}`;
    const pos = mentionStart + file.length + 2;
    setText(next);
    setCaret(pos);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  };

  const menu: { kind: "slash" | "mention"; entries: MenuEntry[] } | null = (() => {
    if (dismissed === text) return null;
    if (slashMatch && slashEntries.length > 0) {
      return {
        kind: "slash" as const,
        entries: slashEntries.map((c) => ({
          key: c.name,
          label: `/${c.name}`,
          detail: c.description,
          apply: () => void chooseCommand(c),
        })),
      };
    }
    if (mentionQuery !== null && !filesLoaded) {
      return {
        kind: "mention" as const,
        entries: [{ key: "scan", label: "Scanning project files…", apply: () => undefined }],
      };
    }
    if (mentionQuery !== null && mentionEntries.length > 0) {
      return {
        kind: "mention" as const,
        entries: mentionEntries.map((f) => ({
          key: f,
          label: f,
          apply: () => insertMention(f),
        })),
      };
    }
    return null;
  })();

  useEffect(() => setMenuIndex(0), [menu?.kind, slashMatch?.[1], mentionQuery]);

  // ------------------------------------------------------------ commands

  const chooseCommand = async (c: SlashCommand) => {
    // A command that is useless without an argument is completed, not run.
    if (c.requiresArgs) {
      setText(`/${c.name} `);
      setCaret(c.name.length + 2);
      return;
    }
    setText("");
    await runSlash(`/${c.name}`);
  };

  const runSlash = async (line: string): Promise<boolean> => {
    const [rawName, args] = splitCommandQuery(line.trim().slice(1));
    const lower = rawName.toLowerCase();
    // Exact name first; otherwise the first prefix match (the CLI dispatches
    // on what its prefix-filtered menu highlights).
    const command =
      COMMANDS.find((c) => c.name === lower) ?? filterCommands(lower)[0];
    if (!command) {
      return false;
    }
    const arg = args.trim();
    const run = async (name: string, a: string) => {
      const res = await window.dustm.runCommand(name, a);
      if (!res.ok) toast(res.error ?? `/${name} failed.`);
    };
    const mode = session.mode;

    switch (command.name) {
      case "help":
        localNote(helpLines().join("\n"));
        break;
      case "switch":
        actions.onOpenAgent();
        break;
      case "new":
      case "clear": {
        const res = await window.dustm.newConversation();
        if (!res.ok) toast(res.error ?? "Could not start a new conversation.");
        break;
      }
      case "resume":
        actions.onOpenResume();
        break;
      case "attach":
        await window.dustm.attach.pickFiles();
        break;
      case "clear-files":
      case "tasks":
      case "compact":
      case "loop":
      case "claude-code-mode":
        await run(command.name, arg);
        break;
      case "btw":
        await run("btw", arg);
        break;
      case "skills":
        if (arg) await run("skills", arg);
        else actions.onOpenSkills();
        break;
      case "auto":
        await window.dustm.setMode(mode === "auto" ? "normal" : "auto");
        break;
      case "plan":
        await window.dustm.setMode(mode === "plan" ? "normal" : "plan");
        break;
      case "normal":
        await window.dustm.setMode("normal");
        break;
      case "folder":
        actions.onChooseFolder();
        break;
      case "exit":
        await window.dustm.quit();
        break;
      case "model": {
        if (!arg) {
          actions.onOpenModel();
          break;
        }
        const clear = arg.toLowerCase() === "default";
        const res = await window.dustm.setModel(clear ? null : arg);
        if (res.ok) {
          localNote(
            clear
              ? "Model: back to the agent's own."
              : `Model: ${arg}\n  Sent with each message from now on. It overrides the agent's own model for you only; /model default to go back.`
          );
        } else {
          toast(res.error ?? "Unknown model.");
        }
        break;
      }
      case "effort": {
        if (!arg) {
          actions.onOpenModel();
          break;
        }
        const level = arg.toLowerCase();
        const value = level === "default" ? null : level;
        const res = await window.dustm.setEffort(value as never);
        if (res.ok) {
          localNote(
            value
              ? `Effort: ${value}\n  Sent with each message from now on. /effort default to go back.`
              : "Effort: back to the agent's own configuration."
          );
        } else {
          toast("Effort must be high, medium, light, none or default.");
        }
        break;
      }
    }
    return true;
  };

  // ------------------------------------------------------------ submit

  const submit = async () => {
    if (inFlight.current) {
      return;
    }
    const value = text.trim();
    if (!value || loading) {
      return;
    }
    inFlight.current = true;
    try {
      // Cleared first, synchronously: the text must be gone before anything is
      // awaited, so nothing can submit it a second time.
      setText("");
      setCaret(0);
      if (value.startsWith("/")) {
        const handled = await runSlash(value);
        if (!handled) {
          setText(value);
          localNote(`Unknown command ${value.split(/\s+/)[0]}. Type /help.`, "error");
        }
        return;
      }
      if (!canSend) {
        setText(value);
        toast(session.folder ? "No agent selected." : "Choose a working folder first.");
        return;
      }
      const res = await window.dustm.send(value);
      if (!res.ok) {
        // Give the text back rather than losing it.
        setText((current) => current || value);
        toast(res.error ?? "Could not send the message.");
      }
    } finally {
      inFlight.current = false;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = menu.entries.length;
        setMenuIndex((i) => (e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n));
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        if (menu.kind === "slash") {
          const c = filterCommands(slashMatch?.[1] ?? "")[menuIndex];
          if (c) {
            setText(`/${c.name} `);
            setCaret(c.name.length + 2);
          }
        } else {
          menu.entries[menuIndex]?.apply();
        }
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (!e.repeat) menu.entries[menuIndex]?.apply();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(text);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // Key auto-repeat must never send again.
      if (!e.repeat) {
        void submit();
      }
    } else if (e.key === "Tab" && e.shiftKey) {
      // Shift+Tab cycles the mode, but only while typing here, so reverse
      // tabbing still works everywhere else.
      e.preventDefault();
      void window.dustm.cycleMode();
    } else if (e.key === "Escape") {
      if (text) {
        setText("");
      } else if (session.busy || session.loop || session.waitingForSlot) {
        // Stopping the agent is deliberate: Escape twice within 1.5 s, from
        // this box, with nothing else open and the key not already used
        // (a popover, or a menu that just closed and handed focus back here).
        const overlayOpen = !!document.querySelector('[role="dialog"], [role="menu"]');
        if (e.repeat || e.defaultPrevented || overlayOpen) {
          return;
        }
        e.preventDefault();
        const now = Date.now();
        if (now - lastEscape.current < 1500) {
          lastEscape.current = 0;
          setStopHint(false);
          void window.dustm.cancel("esc", session.sessionKey);
        } else {
          lastEscape.current = now;
          setStopHint(true);
          setTimeout(() => setStopHint(false), 1500);
        }
      }
    } else if (e.key === "ArrowUp" && !text && session.queue.length > 0) {
      e.preventDefault();
      void window.dustm.recallQueued().then((r) => r.value && setText(r.value));
    }
  };

  // ------------------------------------------------------------ attachments

  const attachFiles = async (list: File[]) => {
    const onDisk = list.filter((f) => window.dustm.hasPath(f));
    if (onDisk.length > 0) {
      const res = await window.dustm.attach.files(onDisk);
      if (!res.ok) toast(res.error ?? "Could not attach the files.");
    }
    for (const file of list) {
      if (onDisk.includes(file)) {
        continue;
      }
      if (!file.type.startsWith("image/")) {
        toast(`${file.name || "That item"} is not a file on disk and cannot be attached.`);
        continue;
      }
      // No path (a screenshot, an image dragged out of a browser): hand main
      // the bytes - after checking the size here, so a huge one is not copied
      // across the bridge only to be refused.
      if (file.size > MAX_PASTED_IMAGE_BYTES) {
        toast(`Image too large: ${formatSize(file.size)}. Maximum size: ${formatSize(MAX_PASTED_IMAGE_BYTES)}.`);
        continue;
      }
      const res = await window.dustm.attach.image(new Uint8Array(await file.arrayBuffer()), file.type);
      if (!res.ok) toast(res.error ?? "Could not attach the image.");
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const list = Array.from(e.clipboardData.files);
    if (list.length > 0) {
      e.preventDefault();
      void attachFiles(list);
      return;
    }
    // Nothing usable in the paste event and no text: ask the OS clipboard
    // (the CLI's own reader: raw image data or a copied file).
    if (!e.clipboardData.getData("text/plain")) {
      e.preventDefault();
      void window.dustm.attach.clipboard().then((r) => {
        if (r.ok && !r.value) toast("The clipboard holds no image or file.", "info");
        if (!r.ok) toast(r.error ?? "Could not read the clipboard.");
      });
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void attachFiles(Array.from(e.dataTransfer.files));
  };

  // ------------------------------------------------------------ render

  const modelLabel = session.modelOverride?.label ?? agent?.model?.modelId ?? "agent default";
  const modelChip = [modelLabel, session.effort].filter(Boolean).join(" · ");
  const bands: string[] = [];
  if (session.compacting) bands.push(session.compacting);
  if (session.btwStatus) bands.push(session.btwStatus);

  return (
    <div
      className={`dock ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {stopHint ? (
        <div className="band-busy" role="status">
          Press Esc again to stop @{agent?.name ?? "the agent"}
        </div>
      ) : null}
      {session.loop ? (
        <div className="band-loop" role="status">
          <span>
            ↻ Looping ({session.loop.runs}/{session.loop.maxRuns}) every{" "}
            {Math.round(session.loop.intervalMs / 1000)}s
            {session.loop.skipped > 0 ? ` · ${session.loop.skipped} skipped (agent busy)` : ""}
          </span>
          <span className="grow" />
          <button type="button" onClick={() => void window.dustm.runCommand("loop", "stop")}>
            Stop loop
          </button>
        </div>
      ) : null}
      {bands.map((b) => (
        <div className="band-busy" role="status" key={b}>
          <span className="dot" aria-hidden="true" />
          {b}
        </div>
      ))}
      {session.forcedSkills.length > 0 ? (
        <div className="band-busy" role="status">
          Skills for your next message: {session.forcedSkills.join(", ")}
        </div>
      ) : null}

      {session.queue.map((q, i) => (
        <div className="queued" key={q.id}>
          <div className="hd">
            <span className="grow">
              {session.waitingForSlot && i === 0
                ? `WAITING FOR A FREE SLOT · ${session.running} of ${session.maxParallel} agents running`
                : `QUEUED · sends when @${agent?.name ?? "agent"} is free`}
            </span>
            {i === session.queue.length - 1 ? (
              <button
                type="button"
                onClick={() =>
                  void window.dustm.recallQueued().then((r) => r.value && setText(r.value))
                }
              >
                edit
              </button>
            ) : null}
          </div>
          <div className="bd">{q.text}</div>
        </div>
      ))}

      <div className="composer-wrap">
        {menu ? (
          <div className="cmenu" role="listbox" id="composer-menu" aria-label={menu.kind === "slash" ? "Commands" : "Files"}>
            {menu.kind === "mention" ? (
              <div className="pal-group" role="presentation">── mention a file</div>
            ) : null}
            {menu.entries.map((entry, i) => (
              <button
                key={entry.key}
                type="button"
                role="option"
                id={`cmenu-${i}`}
                aria-selected={i === menuIndex}
                className="opt"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setMenuIndex(i)}
                onClick={() => entry.apply()}
              >
                <span className="id">{entry.label}</span>
                {entry.detail ? <span className="desc">{entry.detail}</span> : null}
              </button>
            ))}
            <div className="pal-keys" style={{ padding: "6px 10px" }}>
              ↑↓ move · Enter {menu.kind === "slash" ? "run" : "insert"} · Tab complete · Esc close
            </div>
          </div>
        ) : null}

        {session.attachments.length > 0 ? (
          <ul className="chips-attach" aria-label="Attachments">
            {session.attachments.map((a) => (
              <AttachmentChip key={a.id} a={a} />
            ))}
          </ul>
        ) : null}

        <div className="composer">
          <span className="bar" aria-hidden="true" />
          <div className="main">
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <button type="button" className="who" onClick={actions.onOpenAgent} title="Switch agent">
                @{agent?.name ?? "agent"} ▾
              </button>
              <label htmlFor="composer" className="sr-only">
                Message to {agent?.name ?? "the agent"}
              </label>
            </div>
            <textarea
              id="composer"
              ref={ref}
              rows={2}
              value={text}
              disabled={loading}
              role="combobox"
              aria-expanded={!!menu}
              aria-controls={menu ? "composer-menu" : undefined}
              aria-activedescendant={menu ? `cmenu-${menuIndex}` : undefined}
              aria-autocomplete="list"
              placeholder={
                loading
                  ? "Opening conversation…"
                  : session.folder
                    ? "Ask, type / for commands, @ to mention a file"
                    : "Choose a working folder to begin"
              }
              onChange={(e) => {
                setText(e.target.value);
                setCaret(e.target.selectionStart);
                setDismissed(null);
              }}
              onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              spellCheck={false}
            />
          </div>
          {session.busy ? (
            <button
              type="button"
              className="send stop"
              aria-label="Stop the agent"
              title="Stop (Esc)"
              onClick={(e) => {
                if (e.detail > 1 || Date.now() - stopShownAt.current < 600) return;
                void window.dustm.cancel("button", session.sessionKey);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : null}
          <button
            type="button"
            className="send"
            aria-label={session.busy || session.compacting || session.waitingForSlot ? "Queue message" : "Send"}
            disabled={!text.trim() || !canSend}
            onClick={() => void submit()}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
        {dragging ? <div className="drop-hint" aria-hidden="true">Drop files to attach</div> : null}
      </div>

      <div className="chips">
        <button
          type="button"
          className={`chip ${session.mode}`}
          style={{ color: chatModeColor(session.mode) }}
          title="Permission mode (Shift+Tab in the message box)"
          onClick={() => void window.dustm.cycleMode()}
        >
          {chatModeLabel(session.mode)}
        </button>
        <button type="button" className="chip" onClick={actions.onOpenModel} title="Model and effort (Ctrl+K, /model)">
          {modelChip}
        </button>
        {session.claudeCodeMode ? (
          <button
            type="button"
            className="chip"
            title="Claude Code mode is on. Click to turn it off."
            onClick={() => void window.dustm.runCommand("claude-code-mode", "")}
          >
            ◊ claude-code
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn"
          aria-label="Attach files or images"
          title="Attach files (or drop them here, or paste an image)"
          disabled={loading}
          onClick={() => void window.dustm.attach.pickFiles()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="m21 12-8.5 8.5a5 5 0 0 1-7-7L14 5a3.3 3.3 0 0 1 4.7 4.7L10 18.3a1.7 1.7 0 0 1-2.3-2.3L15.5 8" />
          </svg>
        </button>
        <span className="grow" />
        <span className="hint">Enter send · Shift+Enter new line · Shift+Tab mode</span>
      </div>
    </div>
  );
}

function AttachmentChip({ a }: { a: AttachmentInfo }) {
  return (
    <li className={`attach ${a.status}`}>
      <span className="mono" aria-hidden="true">{a.isImage ? "[img]" : "[file]"}</span>
      <span className="nm" title={a.error ?? a.name}>{a.name}</span>
      <span className="st">
        {a.status === "uploading" ? "uploading…" : a.status === "error" ? "failed" : formatSize(a.size)}
      </span>
      {a.status === "error" && a.error ? <span className="sr-only">{a.error}</span> : null}
      <button
        type="button"
        aria-label={`Remove ${a.name}`}
        onClick={() => void window.dustm.attach.remove(a.id)}
      >
        ×
      </button>
    </li>
  );
}
