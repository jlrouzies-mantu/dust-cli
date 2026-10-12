import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PanelLayout, SessionState } from "../shared/ipc";
import { ApprovalDialog } from "./ApprovalDialog";
import { Composer } from "./Composer";
import { AgentPicker, CommandPalette, ModelPicker, ParallelDialog, ResumePicker, SkillsDialog } from "./Palette";
import type { Command } from "./Palette";
import { Aside, LeftRail, PanelResizer, RightRail, Sidebar, StatusBar } from "./Panels";
import { SettingsDialog } from "./Settings";
import { SignIn } from "./SignIn";
import { Transcript } from "./Transcript";
import { boot, toast, useApp } from "./store";

type Overlay = null | "palette" | "model" | "agent" | "resume" | "skills" | "parallel" | "settings";

function TitleBar({ session, onPalette }: { session: SessionState | null; onPalette?: () => void }) {
  return (
    <>
      <header className="titlebar">
        <span className="name">dustm</span>
        <span className="fork">MANTU FORK</span>
        {session ? (
          <span className="ver">
            v{session.version} (upstream v{session.upstreamVersion})
          </span>
        ) : null}
        <span className="spacer" />
        {session?.mode === "plan" ? (
          <span className="mode-banner">■ plan · writes blocked</span>
        ) : null}
        {onPalette ? (
          <button type="button" className="pill-btn" onClick={onPalette}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            Commands
            <kbd>Ctrl K</kbd>
          </button>
        ) : null}
      </header>
      <div className="rule" />
    </>
  );
}

export function App() {
  const { booted, auth, session, items, firstItemIndex, approval, conversations, toast: toastState } = useApp();
  const [overlay, setOverlay] = useState<Overlay>(null);
  // Panel layout: live while dragging, committed to settings on release.
  const [layoutOverride, setLayoutOverride] = useState<Partial<PanelLayout>>({});
  const layout: PanelLayout | null = session ? { ...session.layout, ...layoutOverride } : null;
  const commitLayout = useCallback((patch: Partial<PanelLayout>) => {
    setLayoutOverride((o) => ({ ...o, ...patch }));
    void window.dustm.setLayout(patch);
  }, []);
  const layoutRef = useRef<PanelLayout | null>(null);
  layoutRef.current = layout;

  useEffect(() => {
    void boot();
  }, []);

  // The window title says when a background conversation needs you.
  const needsYou = session ? session.sessions.filter((x) => x.status === "approval" && !x.selected).length : 0;
  const finished = session ? session.sessions.filter((x) => (x.status === "finished" || x.status === "error") && !x.selected).length : 0;
  useEffect(() => {
    const parts: string[] = [];
    if (needsYou > 0) parts.push(`${needsYou} waiting for you`);
    if (finished > 0) parts.push(`${finished} finished`);
    document.title = parts.length ? `dustm (${parts.join(", ")})` : "dustm";
  }, [needsYou, finished]);

  const chooseFolder = useCallback(async () => {
    const res = await window.dustm.chooseFolder();
    if (!res.ok) toast(res.error ?? "Could not set the folder.");
  }, []);

  // A file dropped outside the composer must never navigate the window.
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  // Global shortcuts. Shift+Tab lives in the composer on purpose.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+B / Ctrl+Alt+B: collapse the left / right panel (no other binding uses B).
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b" && layoutRef.current) {
        e.preventDefault();
        if (e.altKey) commitLayout({ rightCollapsed: !layoutRef.current.rightCollapsed });
        else commitLayout({ leftCollapsed: !layoutRef.current.leftCollapsed });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        if (auth.kind === "ready" && !approval) setOverlay((o) => (o === "settings" ? null : "settings"));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (auth.kind === "ready" && !approval) {
          setOverlay((o) => (o ? null : "palette"));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [auth.kind, approval, commitLayout]);

  const commands = useMemo<Command[]>(
    () => [
      { id: "model", label: "/model · Choose model and effort", hint: "Live workspace list", keys: "Ctrl K", run: () => setOverlay("model") },
      { id: "agent", label: "/agent · Switch agent", hint: "Who you are talking to", run: () => setOverlay("agent") },
      { id: "new", label: "/new · New chat", hint: "Start a fresh conversation", run: () => void window.dustm.newConversation().then((r) => !r.ok && toast(r.error ?? "")) },
      { id: "folder", label: "/folder · Choose working folder", hint: "Sets the file-tool sandbox", run: () => void chooseFolder() },
      { id: "mode", label: "Cycle mode", hint: "normal → auto-edit → plan", keys: "Shift+Tab", run: () => void window.dustm.cycleMode() },
      { id: "plan", label: "/plan · Plan mode", hint: "Research only until you approve", run: () => void window.dustm.setMode("plan") },
      { id: "auto", label: "/auto · Auto-edit mode", hint: "Edits apply without asking", run: () => void window.dustm.setMode("auto") },
      { id: "normal", label: "/normal · Normal mode", hint: "You approve each edit", run: () => void window.dustm.setMode("normal") },
      { id: "signout", label: "Sign out", hint: "Also signs out the dustm CLI", run: () => void window.dustm.auth.signOut() },
      { id: "resume", label: "/resume · Resume a conversation", hint: "Recent conversations", run: () => setOverlay("resume") },
      { id: "compact", label: "/compact · Compact conversation", hint: "Summarize to free context", run: () => void window.dustm.runCommand("compact", "") },
      { id: "skills", label: "/skills · Skills", hint: "Switch local skills on and off", run: () => setOverlay("skills") },
      { id: "claude", label: "/claude-code-mode", hint: "Prime the agent with Claude Code memories", run: () => void window.dustm.runCommand("claude-code-mode", "") },
      { id: "tasks", label: "/tasks · Show tasks", hint: "Current task list", run: () => void window.dustm.runCommand("tasks", "") },
      { id: "attach", label: "/attach · Attach files", hint: "Or drop files, or paste an image", run: () => void window.dustm.attach.pickFiles() },
      { id: "parallel", label: "/parallel · Max parallel agents", hint: "How many conversations may run at once", run: () => setOverlay("parallel") },
      { id: "settings", label: "Settings · Notifications and sounds", hint: "Pop-up, sound and volume per event", keys: "Ctrl ,", run: () => setOverlay("settings") },
      { id: "notify",
        label: "Notifications: toggle desktop alerts",
        hint: "Finished, needs approval, errors (when the conversation is not in view)",
        run: () => void window.dustm.setNotify({ enabled: !session?.notify.enabled }),
      },
      { id: "update", label: "Check for updates", disabled: true, run: () => undefined },
    ],
    [chooseFolder, session?.notify.enabled]
  );

  let appState: string = "loading";
  if (booted) {
    appState = auth.kind === "ready" ? (session ? "ready" : "loading") : auth.kind;
  }

  let body;
  if (!booted || auth.kind === "checking") {
    body = <div className="splash" role="status">Starting…</div>;
  } else if (auth.kind !== "ready") {
    body = <SignIn status={auth} />;
  } else if (!session) {
    body = <div className="splash" role="status">Loading your workspace…</div>;
  } else {
    const last = items[items.length - 1];
    const streaming = last?.kind === "agent-text" && last.streaming;
    body = (
      <>
        <div
          className="body"
          style={{
            gridTemplateColumns: `${layout?.leftCollapsed ? 44 : layout?.left ?? 280}px minmax(0, 1fr) ${layout?.rightCollapsed ? 44 : layout?.right ?? 290}px`,
          }}
        >
          {layout?.leftCollapsed ? (
            <LeftRail session={session} onExpand={() => commitLayout({ leftCollapsed: false })} />
          ) : (
            <div className="panel-wrap">
              <Sidebar session={session} conversations={conversations} onSettings={() => setOverlay("settings")} onCollapse={() => commitLayout({ leftCollapsed: true })} />
              <PanelResizer
                side="left"
                width={layout?.left ?? 280}
                min={200}
                max={480}
                onChange={(w) => setLayoutOverride((o) => ({ ...o, left: w }))}
                onCommit={(w) => commitLayout({ left: w })}
              />
            </div>
          )}
          <main className="center" aria-label="Chat">
            {session.loadingConversationId ? (
              <div className="empty" role="status" aria-live="polite">
                <span className="spinner" aria-hidden="true" />
                <h1>Opening conversation…</h1>
                <p>Fetching the latest messages.</p>
              </div>
            ) : items.length === 0 ? (
              <div className="empty">
                {session.agents.length === 0 ? (
                  <>
                    <h1>Could not load agents</h1>
                    <p>{session.notice ?? "Check your connection and restart the app."}</p>
                  </>
                ) : session.folder ? (
                  <>
                    <h1>What are we working on?</h1>
                    <p>
                      @{session.agents.find((a) => a.sId === session.agentId)?.name} can read, edit and run
                      commands inside <span className="mono">{session.folder}</span>.
                    </p>
                    <button type="button" className="btn-quiet" onClick={() => void chooseFolder()}>
                      Change folder
                    </button>
                  </>
                ) : (
                  <>
                    <h1>Choose a working folder</h1>
                    <p>
                      The agent’s file and command tools are limited to one folder. Pick the project you want
                      to work on; it is remembered for next time.
                    </p>
                    <button type="button" className="btn-primary" autoFocus onClick={() => void chooseFolder()}>
                      Choose folder…
                    </button>
                  </>
                )}
                {session.notice && session.agents.length > 0 ? (
                  <div className="err-box" role="alert">{session.notice}</div>
                ) : null}
              </div>
            ) : (
              <Transcript
                key={session.sessionKey}
                items={items}
                firstItemIndex={firstItemIndex}
                context={{
                  busy: session.busy,
                  label: session.actionLabel ?? (session.thinking ? "Thinking" : null),
                  streaming,
                  pendingAgent: session.pendingAgent,
                  hasEarlier: session.hasEarlier,
                  loadingEarlier: session.loadingEarlier,
                }}
              />
            )}
            <div className="col" style={{ flex: "none" }}>
              {session.notice && items.length > 0 ? (
                <div className="err-box" role="alert" style={{ marginBottom: 8 }}>{session.notice}</div>
              ) : null}
              <Composer
                session={session}
                actions={{
                  onOpenModel: () => setOverlay("model"),
                  onOpenAgent: () => setOverlay("agent"),
                  onOpenResume: () => setOverlay("resume"),
                  onOpenSkills: () => setOverlay("skills"),
                  onChooseFolder: () => void chooseFolder(),
                }}
              />
            </div>
          </main>
          {layout?.rightCollapsed ? (
            <RightRail onExpand={() => commitLayout({ rightCollapsed: false })} />
          ) : (
            <div className="panel-wrap">
              <PanelResizer
                side="right"
                width={layout?.right ?? 290}
                min={220}
                max={480}
                onChange={(w) => setLayoutOverride((o) => ({ ...o, right: w }))}
                onCommit={(w) => commitLayout({ right: w })}
              />
              <Aside session={session} onCollapse={() => commitLayout({ rightCollapsed: true })} />
            </div>
          )}
        </div>
        <StatusBar session={session} />
      </>
    );
  }

  return (
    <div className="app" data-app-state={appState} data-mode={session?.mode ?? "normal"}>
      <TitleBar
        session={session}
        onPalette={auth.kind === "ready" && session ? () => setOverlay("palette") : undefined}
      />
      {body}

      {overlay === "palette" ? <CommandPalette commands={commands} onClose={() => setOverlay(null)} /> : null}
      {overlay === "model" ? <ModelPicker onClose={() => setOverlay(null)} /> : null}
      {overlay === "resume" ? <ResumePicker onClose={() => setOverlay(null)} /> : null}
      {overlay === "skills" ? <SkillsDialog onClose={() => setOverlay(null)} /> : null}
      {overlay === "settings" ? <SettingsDialog onClose={() => setOverlay(null)} /> : null}
      {overlay === "parallel" ? <ParallelDialog onClose={() => setOverlay(null)} /> : null}
      {overlay === "agent" && session ? (
        <AgentPicker agents={session.agents} currentId={session.agentId} onClose={() => setOverlay(null)} />
      ) : null}
      {approval ? <ApprovalDialog key={approval.request.id} request={approval.request} pending={approval.pending} /> : null}
      {toastState ? (
        <div className={`toast ${toastState.tone}`} role="status">
          {toastState.text}
        </div>
      ) : null}
    </div>
  );
}

