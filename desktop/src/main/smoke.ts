import type { BrowserWindow } from "electron";
import { app } from "electron";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { onSessionEvent } from "./bus";
import { startDeviceAuth } from "../../../src/utils/deviceAuth";
import { CLI_VERSION } from "../../../src/utils/version";

/**
 * `dustm-desktop --smoke`: boots main, loads the renderer, and checks auth and
 * the agent list *through the real IPC path* (the renderer's own preload
 * bridge, executed in the page), prints one JSON object and exits.
 *
 * It never sends a chat message. It only touches WorkOS when asked to with
 * --smoke-login, and then only to request a device code (the code itself is
 * not printed).
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SmokeOptions {
  login: boolean;
  chat: string | null;
  shot: string | null;
  demo: string | null;
  dup: boolean;
  profileLoad: boolean;
  commands: boolean;
  attach: string | null;
  btw: string | null;
  escape: boolean;
  audit: boolean;
  deleteProbe: boolean;
  out: string | null;
}

export async function runSmoke(
  win: BrowserWindow,
  options: SmokeOptions,
  consoleMessages: string[]
): Promise<void> {
  const result: Record<string, unknown> = {
    ok: false,
    cliCoreVersion: CLI_VERSION,
    electron: process.versions.electron,
    node: process.versions.node,
  };
  let code = 1;

  const watchdog = setTimeout(() => {
    finish({ ...result, error: "smoke timed out after 120s" }, 1);
  }, 120_000);

  function finish(final: Record<string, unknown>, exitCode: number): void {
    clearTimeout(watchdog);
    const text = JSON.stringify(final, null, 2);
    process.stdout.write(`${text}\n`);
    if (options.out) {
      try {
        writeFileSync(options.out, text, "utf-8");
      } catch {
        // stdout already has it
      }
    }
    app.exit(exitCode);
  }

  try {
    const wc = win.webContents;
    if (wc.isLoading()) {
      await new Promise<void>((resolve) =>
        wc.once("did-finish-load", () => resolve())
      );
    }

    // The real IPC path: renderer -> preload bridge -> ipcMain handler.
    const boot = (await wc.executeJavaScript(
      "window.dustm.bootstrap()",
      true
    )) as {
      auth: { kind: string; reason?: string; message?: string };
      state: {
        workspaceName: string | null;
        agents: { sId: string; name: string }[];
        agentId: string | null;
        folder: string | null;
        notice: string | null;
        version: string;
      } | null;
    };

    result["authenticated"] = boot.auth.kind === "ready";
    result["authStatus"] = boot.auth.kind;
    if (boot.auth.kind === "error") {
      result["authMessage"] = boot.auth.message;
    }
    if (boot.state) {
      result["workspace"] = boot.state.workspaceName;
      result["agentCount"] = boot.state.agents.length;
      result["hasDustAgent"] = boot.state.agents.some((a) => a.sId === "dust");
      result["selectedAgent"] = boot.state.agentId;
      result["folder"] = boot.state.folder;
      result["notice"] = boot.state.notice;
    }

    // Wait for the React app to render a settled screen.
    let appState = "loading";
    for (let i = 0; i < 100 && appState === "loading"; i++) {
      appState = (await wc.executeJavaScript(
        "document.querySelector('[data-app-state]')?.getAttribute('data-app-state') ?? 'loading'",
        true
      )) as string;
      if (appState === "loading") {
        await sleep(150);
      }
    }

    const page = (await wc.executeJavaScript(
      `(async () => {
        await document.fonts.ready;
        return {
          title: document.title,
          fonts: {
            sora: document.fonts.check("600 14px Sora"),
            plex: document.fonts.check("400 14px 'IBM Plex Sans'"),
            mono: document.fonts.check("400 14px 'JetBrains Mono'")
          },
          bridge: Object.keys(window.dustm).sort(),
          // The renderer must not see Node at all.
          nodeLeak: [typeof require, typeof process, typeof module].filter(t => t !== "undefined").length,
          textLength: document.body.innerText.length
        };
      })()`,
      true
    )) as {
      title: string;
      fonts: Record<string, boolean>;
      bridge: string[];
      nodeLeak: number;
      textLength: number;
    };

    result["renderer"] = {
      appState,
      title: page.title,
      rendered: page.textLength > 0 && appState !== "loading",
      fontsLoaded: page.fonts,
      bridgeKeys: page.bridge,
      nodeIsolated: page.nodeLeak === 0,
      consoleProblems: consoleMessages,
    };

    if (options.login) {
      const started = await startDeviceAuth();
      result["login"] = started.isOk()
        ? {
            ok: true,
            verificationHost: new URL(started.value.info.verificationUri).host,
            expiresInSec: Math.round(
              (started.value.info.expiresAt - Date.now()) / 1000
            ),
            userCodeLength: started.value.info.userCode.length,
          }
        : { ok: false, error: started.error.message };
    }

    if (options.chat) {
      result["chat"] = await smokeChat(win, options.chat, options.attach);
    }

    if (options.profileLoad) {
      result["loadProfile"] = await smokeProfileLoad(win);
    }
    if (options.escape) {
      result["escape"] = await smokeEscape(win);
    }
    if (options.btw) {
      result["btw"] = await smokeBtw(options.btw);
    }
    if (options.commands) {
      result["commands"] = await smokeCommands(win);
    }
    if (options.dup) {
      result["duplicateSend"] = await smokeDuplicateSend(win);
    }
    if (options.audit) {
      result["audit"] = await smokeAudit(win);
    }
    if (options.deleteProbe) {
      result["deleteProbe"] = await smokeDeleteProbe();
    }
    if (options.demo) {
      await runDemo(win, options.demo);
      await sleep(700);
    }
    if (options.shot) {
      win.showInactive();
      await sleep(1500);
      const image = await wc.capturePage();
      writeFileSync(options.shot, image.toPNG());
      result["screenshot"] = options.shot;
    }

    const renderer = result["renderer"] as { rendered: boolean; nodeIsolated: boolean };
    result["ok"] =
      renderer.rendered &&
      renderer.nodeIsolated &&
      consoleMessages.length === 0 &&
      (boot.auth.kind === "ready" ? (result["agentCount"] as number) > 0 : true) &&
      (options.audit ? (result["audit"] as { pass: boolean }).pass : true);
    code = result["ok"] ? 0 : 1;
  } catch (error) {
    result["error"] = error instanceof Error ? error.message : String(error);
  }
  finish(result, code);
}

/** One real message through the real session loop. Costs credits: opt-in only. */
async function smokeChat(win: BrowserWindow, text: string, attach: string | null): Promise<unknown> {
  const kinds: Record<string, number> = {};
  const tools: string[] = [];
  let agentChars = 0;
  let answer = "";
  const errors: string[] = [];
  let sawBusy = false;
  let doneBusy = false;
  const off = onSessionEvent((e) => {
    if (e.type === "append") {
      kinds[e.item.kind] = (kinds[e.item.kind] ?? 0) + 1;
      if (e.item.kind === "tool") tools.push(e.item.name);
      if (e.item.kind === "note" && e.item.tone === "error") errors.push(e.item.text.slice(0, 200));
    } else if (e.type === "text-delta") {
      agentChars += e.text.length;
      answer += e.text;
    } else if (e.type === "state") {
      if (e.state.busy) sawBusy = true;
      else if (sawBusy) doneBusy = true;
    }
  });
  let attachStatus: string | undefined;
  if (attach) {
    const session = await import("./session");
    await win.webContents.executeJavaScript(`window.dustm.attach.paths([${JSON.stringify(attach)}])`, true);
    for (let i = 0; i < 200 && session.getState().attachments[0]?.status !== "ready" && session.getState().attachments[0]?.status !== "error"; i++) {
      await sleep(100);
    }
    attachStatus = session.getState().attachments[0]?.status;
  }
  const res = (await win.webContents.executeJavaScript(
    `window.dustm.send(${JSON.stringify(text)})`,
    true
  )) as { ok: boolean; error?: string };
  const started = Date.now();
  while (res.ok && !doneBusy && Date.now() - started < 120_000) {
    await sleep(250);
  }
  off();
  return { attachStatus, answer: answer.slice(0, 160), sent: res.ok, error: res.error, completed: doneBusy, seconds: Math.round((Date.now() - started) / 1000), itemKinds: kinds, tools, agentChars, errors };
}

/**
 * `--smoke-demo=<transcript|approval|plan|signin|model>`: pushes canned events
 * through the same bus the real session uses, so a screenshot (--smoke-shot)
 * shows a screen that is otherwise only reachable mid-conversation.
 */
export async function runDemo(win: BrowserWindow, name: string): Promise<void> {
  const { emit } = await import("./bus");
  const id = (n: string) => `demo-${n}`;
  const diff = {
    path: "src/ui/commands/Chat.tsx",
    added: 1,
    removed: 1,
    truncated: false,
    lines: [
      { t: "ctx" as const, no: 4148, text: "  const resolve = useCallback(() => {" },
      { t: "del" as const, no: 4149, text: "    const choice = MODEL_CATALOG.find(" },
      { t: "add" as const, no: 4149, text: "    const choice = getModelCatalogue().find(" },
      { t: "ctx" as const, no: 4150, text: "      (m) => m.modelId === selected.id" },
      { t: "gap" as const, hidden: 15 },
      { t: "ctx" as const, no: 4166, text: "  }, []);" },
    ],
  };
  if (name === "signin") {
    emit({
      type: "auth",
      status: {
        kind: "signing-in",
        userCode: "BXKD-QMTR",
        verificationUri: "https://signin.dust.tt/device",
        expiresAt: Date.now() + 287_000,
        phase: "waiting",
      },
    });
    return;
  }
  emit({
    type: "transcript-reset",
    items: [
      { kind: "user", id: id("u"), text: "Picking claude-opus-5-5 in /model does nothing. Find out why and fix it." },
      { kind: "agent-header", id: id("h"), agentName: "dust", detail: "claude-opus-5-5 · high" },
      { kind: "tool", id: id("t1"), name: "search_content", detail: '"MODEL_CATALOG" in src/ · 6 matches', status: "ok", startedAt: 0, durationMs: 1200 },
      { kind: "tool", id: id("t2"), name: "read_file", detail: "src/ui/commands/Chat.tsx · 4150–4185", status: "ok", startedAt: 0, durationMs: 300 },
      { kind: "agent-text", id: id("a1"), streaming: false, text: "Found it. The picker is built from the live workspace list, but pressing Enter looks the choice up in the hardcoded `MODEL_CATALOG`, which has no `claude-opus-5-5`.\n\n```ts\nconst choice = MODEL_CATALOG.find((m) => m.modelId === id);\n```\n\n- route the lookup through one helper\n- add a test" },
      { kind: "diff", id: id("d"), tool: "edit_file", diff },
      { kind: "tool", id: id("t3"), name: "run_command", detail: "npm run build:prod", status: "running", startedAt: Date.now() - 14_000, durationMs: null },
      ...(name === "plan"
        ? [{ kind: "plan" as const, id: id("p"), outcome: "pending" as const, markdown: "# dustm Desktop, phase 1\n\n1. **Extract a UI-free core** from Chat.tsx\n2. **Add desktop/** with an Electron main process\n3. **Typed IPC** through a preload bridge\n4. **React renderer** in the Mantu look\n5. **Package and release** with electron-builder" }]
        : []),
    ],
  });
  if (name === "plan") {
    emit({ type: "plan-request", id: id("p"), markdown: "" });
  }
  if (name === "approval") {
    emit({
      type: "approval",
      pending: 1,
      request: { id: id("ap"), type: "edit", tool: "edit_file", diff, insideSandbox: true, sandbox: "Filesystem access limited to C:/Users/me/source/repos/dust-cli" },
    });
  }
  // States that exist only mid-flight: shown by emitting a state event with
  // the relevant fields overridden (the next real state event replaces it).
  const session = await import("./session");
  const override = (patch: Record<string, unknown>) => {
    const send = () => emit({ type: "state", state: { ...session.getState(), ...patch } });
    send();
    // Re-asserted for a few seconds so a real state event landing in between
    // (usage refresh, etc.) cannot replace the demo state before the shot.
    const timer = setInterval(send, 250);
    setTimeout(() => clearInterval(timer), 4500);
  };
  const typeInto = (value: string, caretAt: number) =>
    win.webContents.executeJavaScript(
      `(() => { const el = document.getElementById("composer"); el.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
        el.setSelectionRange(${caretAt}, ${caretAt});
        el.dispatchEvent(new Event("input", { bubbles: true })); })()`,
      true
    );
  if (name === "thinking") {
    emit({
      type: "transcript-reset",
      items: [
        { kind: "user", id: id("u"), text: "whats the status" },
      ],
    });
    override({
      busy: true,
      thinking: true,
      pendingAgent: { name: "dust", detail: "claude-opus-5-5 · high" },
    });
  }
  if (name === "loading") {
    const list = await session.listConversations();
    override({ loadingConversationId: list.value?.[1]?.sId ?? "x" });
  }
  if (name === "search") {
    await win.webContents.executeJavaScript(
      `(() => { const el = document.getElementById("convo-search"); el.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "tool");
        el.dispatchEvent(new Event("input", { bubbles: true })); })()`,
      true
    );
  }
  if (name === "slash") {
    await typeInto("/", 1);
  }
  if (name === "mention") {
    await typeInto("look at @pack", 13);
    await session.mentionFiles(); // warm the (asynchronous) project scan
    await sleep(1500);
  }
  if (name === "attach") {
    override({
      attachments: [
        { id: "a1", name: "pasted-image-1760000000.png", size: 184_320, contentType: "image/png", isImage: true, status: "ready" },
        { id: "a2", name: "report-q3.pdf", size: 2_400_000, contentType: "application/pdf", isImage: false, status: "uploading" },
        { id: "a3", name: "archive.zip", size: 0, contentType: "", isImage: false, status: "error", error: "Unsupported file type: .zip" },
      ],
    });
  }
  if (name === "model") {
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))`,
      true
    );
    await sleep(300);
    await win.webContents.executeJavaScript(
      `(() => { const i = document.querySelector('#cmd-q'); i.focus(); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`,
      true
    );
  }
}

/**
 * `--smoke-dup`: fires the same message many times as fast as it can, through
 * (a) the real composer textarea (Enter key events, some with repeat=true) and
 * (b) the raw IPC `send` call, against a stubbed Dust client so no credits are
 * spent. Passes only if each scenario produces exactly one turn and the queue
 * never holds a copy. Needs --folder.
 */
async function smokeDuplicateSend(win: BrowserWindow): Promise<unknown> {
  const { Ok } = await import("@dust-tt/client");
  const session = await import("./session");
  const calls = { create: 0, post: 0, texts: [] as string[] };
  let n = 0;
  const fake = {
    createConversation: async (args: { message: { content: string } }) => {
      calls.create++;
      calls.texts.push(args.message.content);
      return new Ok({
        conversation: { sId: `conv-test-${++n}`, title: "t" },
        message: { sId: "u1" },
      });
    },
    postUserMessage: async (args: { message: { content: string } }) => {
      calls.post++;
      calls.texts.push(args.message.content);
      return new Ok({ sId: "u2" });
    },
    getConversation: async () => new Ok({ sId: "conv-test", title: "t", content: [] }),
    streamAgentAnswerEvents: async () =>
      new Ok({
        eventStream: (async function* () {
          yield { type: "generation_tokens", classification: "tokens", text: "ok", messageId: "m1" };
          await sleep(400);
          yield { type: "agent_message_success", message: { sId: "m1", content: "ok" } };
        })(),
      }),
    cancelMessageGeneration: async () => new Ok({}),
  };
  session.setTestClient(fake);

  const wc = win.webContents;
  let maxQueue = 0;
  const off = onSessionEvent((e) => {
    if (e.type === "state") maxQueue = Math.max(maxQueue, e.state.queue.length);
  });
  const settle = async () => {
    const start = Date.now();
    await sleep(200);
    while (Date.now() - start < 20_000) {
      const s = session.getState();
      if (!s.busy && s.queue.length === 0) break;
      await sleep(100);
    }
    await sleep(600); // a late queued duplicate would start here
  };
  const total = () => calls.create + calls.post;
  const out: Record<string, unknown> = {};

  try {
    // (a) composer: 6 Enter presses back to back, the last three as key repeat.
    session.newConversation();
    await sleep(200);
    await wc.executeJavaScript(
      `(async () => {
        const el = document.getElementById("composer");
        el.focus();
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        set.call(el, "whats the status");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise(r => setTimeout(r, 80));
        for (let i = 0; i < 6; i++) {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, repeat: i >= 3 }));
        }
      })()`,
      true
    );
    await settle();
    // What the user sees, not just what the server got: the renderer once
    // subscribed to events twice under StrictMode (dev), so one real turn
    // rendered as two. Count the message in the transcript itself.
    const rendered = (await wc.executeJavaScript(
      `globalThis.__dustmItemKinds().filter((k) => k === "user").length`,
      true
    )) as number;
    out["composer"] = {
      turns: total(),
      maxQueue,
      rendered,
      pass: total() === 1 && maxQueue === 0 && rendered === 1,
    };

    // (b) IPC: the same text 6 times concurrently, plus once more 3s later
    // (not a duplicate any more: it is a deliberate re-send).
    calls.create = 0;
    calls.post = 0;
    maxQueue = 0;
    session.newConversation();
    await sleep(200);
    await wc.executeJavaScript(
      `Promise.all(Array.from({ length: 6 }, () => window.dustm.send("status please")))`,
      true
    );
    await settle();
    out["ipc"] = { turns: total(), maxQueue, pass: total() === 1 && maxQueue === 0 };

    // (c) a different message while busy must still queue and run.
    calls.create = 0;
    calls.post = 0;
    maxQueue = 0;
    session.newConversation();
    await sleep(200);
    await wc.executeJavaScript(
      `(async () => { await window.dustm.send("first"); await window.dustm.send("second"); })()`,
      true
    );
    await settle();
    out["distinctQueued"] = { turns: total(), texts: calls.texts.slice(-2), pass: total() === 2 };
  } finally {
    off();
    session.setTestClient(null);
  }
  return out;
}
/** --smoke-profile-load: opens the most recent conversations and reports where the time goes. */
/** : opens the most recent conversations and reports where the time goes. */
async function smokeProfileLoad(win: BrowserWindow): Promise<unknown> {
  const session = await import("./session");
  const list = await session.listConversations();
  const rows: unknown[] = [];
  for (const c of (list.value ?? []).slice(0, 6)) {
    const t = Date.now();
    const res = await win.webContents.executeJavaScript(
      `window.dustm.loadConversation(${JSON.stringify(c.sId)})`,
      true
    );
    const total = Date.now() - t;
    await sleep(300);
    rows.push({ ok: res.ok, totalMs: total, ...session.lastLoadTimings, raw: await rawConversationTiming(c.sId), priv: await privateMessagesProbe(c.sId) });
  }
  return rows;
}

/** Raw HTTP timing for one conversation, to split network from SDK parsing. */
export async function rawConversationTiming(id: string): Promise<unknown> {
  const AuthService = (await import("../../../src/utils/authService")).default;
  const { getApiDomain } = await import("../../../src/utils/dustClient");
  const TokenStorage = (await import("../../../src/utils/tokenStorage")).default;
  const token = await AuthService.getValidAccessToken();
  const wId = await TokenStorage.getWorkspaceId();
  const domain = getApiDomain(await TokenStorage.getRegion());
  if (token.isErr() || !token.value || !wId || domain.isErr()) return { error: "no auth" };
  const url = `${domain.value}/api/v1/w/${wId}/assistant/conversations/${id}`;
  const t0 = Date.now();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token.value}` } });
  const text = await res.text();
  const t1 = Date.now();
  const json = JSON.parse(text);
  const t2 = Date.now();
  return { status: res.status, bytes: text.length, fetchMs: t1 - t0, jsonParseMs: t2 - t1, keys: Object.keys(json.conversation ?? json).length };
}

export async function privateMessagesProbe(id: string): Promise<unknown> {
  const AuthService = (await import("../../../src/utils/authService")).default;
  const { getApiDomain } = await import("../../../src/utils/dustClient");
  const TokenStorage = (await import("../../../src/utils/tokenStorage")).default;
  const token = await AuthService.getValidAccessToken();
  const wId = await TokenStorage.getWorkspaceId();
  const domain = getApiDomain(await TokenStorage.getRegion());
  if (token.isErr() || !token.value || !wId || domain.isErr()) return { error: "no auth" };
  const out: Record<string, unknown> = {};
  for (const q of ["limit=10", "limit=10&lastValue=120", "limit=10&lastRank=120", "limit=10&orderColumn=rank&orderDirection=desc&lastValue=120"]) {
    const t0 = Date.now();
    const res = await fetch(`${domain.value}/api/w/${wId}/assistant/conversations/${id}/messages?${q}`, { headers: { Authorization: `Bearer ${token.value}` } });
    const text = await res.text();
    const ms = Date.now() - t0;
    let shape: unknown = null;
    try {
      const body = JSON.parse(text);
      const m = (body.messages ?? [])[0] ?? {};
      shape = { bodyKeys: Object.keys(body), hasMore: body.hasMore, lastValue: body.lastValue, count: (body.messages ?? []).length, firstType: m.type, firstKeys: Object.keys(m).slice(0, 30), ranks: (body.messages ?? []).map((x: { rank: number }) => x.rank), types: (body.messages ?? []).slice(0, 6).map((x: { type: string; content?: string; actions?: unknown[] }) => `${x.type}:${(x.content ?? "").length}:${(x.actions ?? []).length}`) };
    } catch {
      shape = text.slice(0, 200);
    }
    out[q] = { status: res.status, bytes: text.length, ms, shape };
  }
  return out;
}

/**
 * `--smoke-commands`: exercises the slash-command logic that lives in main,
 * mostly against a stubbed Dust client (no credits): command notes, the loop
 * guard and tick, the "compaction makes the conversation busy" rule, content
 * fragments for attachments, and the skills singleton invariant. Needs --folder.
 */
async function smokeCommands(win: BrowserWindow): Promise<unknown> {
  const { Ok } = await import("@dust-tt/client");
  const session = await import("./session");
  const { areClaudeSkillsEnabled } = await import("../../../src/utils/skillStore");
  const order: string[] = [];
  let n = 0;
  const fake = {
    createConversation: async () => {
      order.push("create");
      return new Ok({ conversation: { sId: `conv-test-${++n}`, title: "t" }, message: { sId: "u1" } });
    },
    postUserMessage: async () => {
      order.push("message");
      return new Ok({ sId: "u2" });
    },
    postContentFragment: async () => {
      order.push("fragment");
      return new Ok({});
    },
    uploadFile: async () => {
      order.push("upload");
      return new Ok({ id: "file-1" });
    },
    getConversation: async () => new Ok({ sId: "conv-test", title: "t", content: [] }),
    streamAgentAnswerEvents: async () =>
      new Ok({
        eventStream: (async function* () {
          yield { type: "generation_tokens", classification: "tokens", text: "ok", messageId: "m1" };
          await sleep(300);
          yield { type: "agent_message_success", message: { sId: "m1", content: "ok" } };
        })(),
      }),
    cancelMessageGeneration: async () => new Ok({}),
  };
  const notes: string[] = [];
  const off = onSessionEvent((e) => {
    if (e.type === "append" && e.item.kind === "note") notes.push(e.item.text);
  });
  const lastNote = () => notes[notes.length - 1] ?? "";
  const idle = async () => {
    await sleep(150);
    for (let i = 0; i < 100; i++) {
      const s = session.getState();
      if (!s.busy && !s.compacting && s.queue.length === 0) break;
      await sleep(100);
    }
  };
  const out: Record<string, unknown> = {};
  const turns = () => order.filter((o) => o === "message" || o === "create").length;

  try {
    session.newConversation();
    await session.runCommand("tasks", "");
    out["tasksEmpty"] = lastNote().startsWith("Tasks: none yet");
    await session.runCommand("compact", "");
    out["compactNothing"] = lastNote().startsWith("Nothing to compact");
    await session.runCommand("btw", "");
    out["btwUsage"] = lastNote().startsWith("Usage: /btw");
    await session.runCommand("loop", "");
    out["loopStatus"] = lastNote().includes("No loop running");
    await session.runCommand("loop", "10s ping");
    out["loopFloorRefused"] = session.getState().loop === null && lastNote().length > 0;
    await session.runCommand("skills", "");
    out["skillsList"] = lastNote().startsWith("Skills:");
    await session.runCommand("skills", "no-such-skill-xyz");
    out["skillsNotFound"] = lastNote().startsWith('No skill named "no-such-skill-xyz"');

    // Skills singleton: set from exactly one place, so state and singleton agree.
    const before = session.getState().claudeCodeMode;
    await session.runCommand("claude-code-mode", "");
    const mid = session.getState().claudeCodeMode;
    out["claudeMode"] = {
      toggled: mid !== before ? "on" : "stayed off (no memories found)",
      singletonMatchesState: areClaudeSkillsEnabled() === mid,
    };
    if (mid) {
      await session.runCommand("claude-code-mode", "");
      (out["claudeMode"] as Record<string, unknown>)["offAgain"] =
        session.getState().claudeCodeMode === false && areClaudeSkillsEnabled() === false;
    }

    // Everything below uses the stub client.
    session.setTestClient(fake);

    // Loop: first tick fires at once; a 30s interval means no second tick here.
    await session.runCommand("loop", "30s x2 ping");
    await idle();
    out["loopTick"] = {
      turns: turns(),
      runs: session.getState().loop?.runs,
      pass: turns() === 1 && session.getState().loop?.runs === 1,
    };
    await session.runCommand("loop", "stop");
    out["loopStopped"] = session.getState().loop === null;

    // Compaction is busy for every send path: a message sent meanwhile queues.
    order.length = 0;
    await session.runCommand("compact", "");
    const compactingNow = session.getState().compacting !== null;
    session.send("sent during compaction");
    const queuedDuring = session.getState().queue.length === 1 && turns() === 0;
    await idle();
    out["compactionBusy"] = {
      compactingNow,
      queuedDuring,
      drainedAfter: turns() === 1,
      pass: compactingNow && queuedDuring && turns() === 1,
    };

    // Attachments: error chips for bad paths; a good file uploads, then goes
    // out as a content fragment BEFORE the message.
    session.newConversation();
    order.length = 0;
    await session.attachPaths([path.join(process.cwd(), "does-not-exist.pdf")]);
    const badChip = session.getState().attachments[0];
    session.removeAttachment(badChip.id);
    await session.attachPaths([path.join(process.cwd(), "package.json")]);
    for (let i = 0; i < 50 && session.getState().attachments[0]?.status === "uploading"; i++) {
      await sleep(100);
    }
    const goodChip = session.getState().attachments[0];
    session.send("what is attached?");
    await idle();
    out["attachments"] = {
      badChipStatus: badChip.status,
      goodChipStatus: goodChip?.status,
      callOrder: order.join(">"),
      chipsClearedAfterSend: session.getState().attachments.length === 0,
      pass:
        badChip.status === "error" &&
        goodChip?.status === "ready" &&
        order.join(">") === "create>upload>fragment>message",
    };
  } finally {
    off();
    session.stopLoop("smoke done");
    session.setTestClient(null);
  }
  return out;
}

/**
 * `--smoke-audit`: regression cases for the second-pass review's fixes, all
 * against a stubbed Dust client (no credits). Self-contained: it works in a
 * temp folder with its own fixture (restoring the previous folder after), and
 * every case starts from `fresh()`, so neither --folder nor case order
 * matters. Each case has a `pass` flag; the top-level `pass` is their
 * conjunction.
 */
async function smokeAudit(win: BrowserWindow): Promise<unknown> {
  const { Ok, Err } = await import("@dust-tt/client");
  const session = await import("./session");
  const { itemsFromMessages } = await import("./history");
  const { isPlanModeActive } = await import("../../../src/utils/planMode");
  const wc = win.webContents;
  const run = (js: string) => wc.executeJavaScript(js, true);

  let n = 0;
  const calls = { turns: 0, cancels: 0, deleted: [] as string[], created: [] as string[] };
  // Per-case knobs.
  let streamHoldMs = 300;
  let streamNeverEnds = false;
  let createDelayMs = 0;
  let uploadFails = false;
  const fake = {
    createConversation: async (args: { message?: unknown }) => {
      if (createDelayMs) await sleep(createDelayMs);
      const sId = `conv-audit-${++n}`;
      calls.created.push(sId);
      if (args.message) calls.turns++;
      return new Ok({ conversation: { sId, title: "t" }, message: args.message ? { sId: "u1" } : undefined });
    },
    postUserMessage: async () => {
      calls.turns++;
      return new Ok({ sId: "u2" });
    },
    postContentFragment: async () => new Ok({}),
    uploadFile: async () => (uploadFails ? new Err(new Error("stub upload refused")) : new Ok({ id: "file-1" })),
    getConversation: async () => new Ok({ sId: "conv-loaded", title: "loaded", content: [] }),
    streamAgentAnswerEvents: async ({ signal }: { signal?: AbortSignal }) =>
      new Ok({
        eventStream: (async function* () {
          yield { type: "generation_tokens", classification: "tokens", text: "ok", messageId: "m1" };
          if (streamNeverEnds) {
            await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
            throw new Error("aborted");
          }
          await sleep(streamHoldMs);
          yield { type: "agent_message_success", message: { sId: "m1", content: "ok" } };
        })(),
      }),
    cancelMessageGeneration: async () => {
      calls.cancels++;
      return new Ok({});
    },
    deleteConversation: async (id: string) => {
      calls.deleted.push(id);
    },
  };

  const events: { type: string; at: number }[] = [];
  const off = onSessionEvent((e) => events.push({ type: e.type, at: Date.now() }));
  const idle = async (maxMs = 15_000) => {
    const start = Date.now();
    await sleep(150);
    while (Date.now() - start < maxMs) {
      const s = session.getState();
      if (!s.busy && !s.compacting && s.queue.length === 0) break;
      await sleep(100);
    }
  };
  const waitBusy = async () => {
    for (let i = 0; i < 50 && !session.getState().busy; i++) await sleep(50);
  };
  const uploadsSettled = async () => {
    for (let i = 0; i < 60 && session.getState().attachments.some((a) => a.status === "uploading"); i++) await sleep(50);
    await sleep(300);
  };
  const out: Record<string, { pass: boolean } & Record<string, unknown>> = {};

  // Self-contained: its own working folder and attachment fixture, so the
  // result does not depend on --folder or on whatever folder the app
  // remembers (an earlier version used <cwd>/package.json and failed in any
  // folder without one). The previous folder is restored at the end.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const auditDir = mkdtempSync(path.join(os.tmpdir(), "dustm-audit-"));
  const fixtureName = "audit-fixture.json";
  const pkg = path.join(auditDir, fixtureName);
  writeFileSync(pkg, JSON.stringify({ name: "dustm-audit-fixture" }), "utf-8");
  const previousFolder = session.getState().folder;
  const folderSet = session.setFolder(auditDir, false);
  if (!folderSet.ok) {
    return { pass: false, error: `could not set the audit folder: ${folderSet.error}` };
  }

  // Every case starts from the same state, whatever the previous one left:
  // no turn, no loop, no queue, no attachments, a new chat, default knobs.
  const fresh = async () => {
    streamHoldMs = 300;
    streamNeverEnds = false;
    createDelayMs = 0;
    uploadFails = false;
    session.stopLoop("audit reset", { quiet: true });
    if (session.getState().busy) {
      await session.cancel();
    }
    await idle(session.CANCEL_FALLBACK_MS + 3000);
    await uploadsSettled();
    await session.runCommand("clear-files", "");
    session.setMode("normal");
    session.newConversation();
    await sleep(100);
    calls.turns = 0;
    calls.cancels = 0;
    calls.deleted = [];
    calls.created = [];
  };

  session.setTestClient(fake);
  try {
    // 1. A dropped duplicate is reported, never silent.
    await fresh();
    const first = session.send("audit duplicate");
    const second = session.send("audit duplicate");
    await idle();
    out["duplicateIsReported"] = {
      firstOk: first.ok,
      secondOk: second.ok,
      secondError: second.error,
      turns: calls.turns,
      pass: first.ok && !second.ok && /2 seconds/.test(second.error ?? "") && calls.turns === 1,
    };

    // 2. The same text repeated deliberately (after the window) while the
    // agent is busy queues and drains: the guard never eats a real repeat.
    await fresh();
    streamHoldMs = 2600;
    session.send("audit repeat");
    await waitBusy();
    await sleep(2100);
    const repeat = session.send("audit repeat");
    const queued = session.getState().queue.length;
    await idle();
    streamHoldMs = 300;
    out["deliberateRepeatQueuesAndDrains"] = {
      repeatOk: repeat.ok,
      queued,
      turns: calls.turns,
      pass: repeat.ok && queued === 1 && calls.turns === 2,
    };

    // 3. Sign-out mid-turn: everything bound to the old identity stops.
    await fresh();
    streamNeverEnds = true;
    let fsClosed = false;
    const realFs = session.setFsServerForTest("fs-old", async () => {
      fsClosed = true;
    });
    session.send("audit long turn");
    await waitBusy();
    await sleep(150);
    session.setMode("plan");
    await session.runCommand("loop", "30s x3 audit tick");
    const before = session.getState();
    const tornAt = Date.now();
    await session.teardownSession();
    await sleep(800);
    const after = session.getState();
    const lateAppends = events.filter((e) => e.type === "append" && e.at > tornAt).length;
    streamNeverEnds = false;
    out["signOutMidTurn"] = {
      wasBusy: before.busy,
      loopWasOn: before.loop !== null,
      busyAfter: after.busy,
      loopAfter: after.loop,
      modeAfter: after.mode,
      planSingletonAfter: isPlanModeActive(),
      conversationAfter: after.conversationId,
      serverCancelled: calls.cancels > 0,
      fsClosed,
      lateAppends,
      pass:
        before.busy &&
        before.loop !== null &&
        !after.busy &&
        after.loop === null &&
        after.mode === "normal" &&
        !isPlanModeActive() &&
        after.conversationId === null &&
        calls.cancels > 0 &&
        fsClosed &&
        lateAppends === 0,
    };
    // Put the real server back (teardown only closed the fake one), so no
    // later step registers a second real one.
    session.setFsServerForTest(realFs.id, realFs.close);

    // 3b. Straight after a teardown (no reset in between, as for a user who
    // signs out and back in), attaching and sending still work end to end.
    calls.created = [];
    calls.turns = 0;
    await session.attachPaths([pkg]);
    await uploadsSettled();
    const postTeardownChip = session.getState().attachments[0];
    const postTeardownSend = session.send("audit after teardown");
    await idle();
    out["attachAndSendAfterTeardown"] = {
      chip: postTeardownChip?.status,
      chipError: postTeardownChip?.error,
      created: calls.created.length,
      sendOk: postTeardownSend.ok,
      turns: calls.turns,
      pass:
        postTeardownChip?.status === "ready" &&
        calls.created.length === 1 &&
        postTeardownSend.ok &&
        calls.turns === 1,
    };

    // 4. New chat while the first upload is still creating the conversation:
    // the created conversation must not hijack the new chat, and is deleted.
    await fresh();
    createDelayMs = 500;
    await session.attachPaths([pkg]);
    await sleep(100);
    session.newConversation();
    await sleep(900);
    createDelayMs = 0;
    out["uploadRaceWithNewChat"] = {
      conversationAfter: session.getState().conversationId,
      created: calls.created,
      deleted: calls.deleted,
      pass:
        session.getState().conversationId === null &&
        calls.created.length === 1 &&
        calls.deleted.includes(calls.created[0]),
    };

    // 5. A failed upload leaves no empty conversation behind.
    await fresh();
    uploadFails = true;
    await session.attachPaths([pkg]);
    await uploadsSettled();
    uploadFails = false;
    const failedChip = session.getState().attachments[0];
    out["failedUploadNoEmptyConversation"] = {
      chip: failedChip?.status,
      // Must be the stub's refusal, not a validation error before upload.
      chipError: failedChip?.error,
      conversationAfter: session.getState().conversationId,
      deleted: calls.deleted,
      pass:
        failedChip?.status === "error" &&
        session.getState().conversationId === null &&
        /stub upload refused/.test(failedChip?.error ?? "") &&
        calls.created.length === 1 &&
        calls.deleted.includes(calls.created[0]),
    };

    // 6. Removing the last attachment discards the files-only conversation;
    // one that received a message is never deleted.
    await fresh();
    await session.attachPaths([pkg]);
    await uploadsSettled();
    const chip = session.getState().attachments[0];
    session.removeAttachment(chip?.id ?? "");
    await sleep(200);
    const removedDeleted = calls.deleted.length === 1;
    calls.deleted = [];
    await session.attachPaths([pkg]);
    await uploadsSettled();
    session.send("audit with file");
    await idle();
    await session.runCommand("clear-files", "");
    session.newConversation();
    await sleep(200);
    out["filesOnlyConversationLifecycle"] = {
      chip: chip?.status,
      chipError: chip?.error,
      removedDeleted,
      deletedAfterMessage: calls.deleted,
      pass: chip?.status === "ready" && removedDeleted && calls.deleted.length === 0,
    };

    // 7. Opening another conversation stops a running loop (it must not post
    // into a different conversation than the one it was started in).
    await fresh();
    await session.runCommand("loop", "30s x3 audit loop");
    await idle();
    const loopBefore = session.getState().loop !== null;
    const loaded = await session.loadConversation("conv-loaded");
    out["openingAnotherConversationStopsLoop"] = {
      loopBefore,
      loaded: loaded.ok,
      loopAfter: session.getState().loop,
      pass: loopBefore && loaded.ok && session.getState().loop === null,
    };

    // 8. Cancel whose stream never confirms: the turn still ends.
    await fresh();
    streamNeverEnds = true;
    session.send("audit cancel");
    await waitBusy();
    await sleep(150);
    const cancelAt = Date.now();
    await session.cancel();
    while (session.getState().busy && Date.now() - cancelAt < session.CANCEL_FALLBACK_MS + 3000) {
      await sleep(100);
    }
    streamNeverEnds = false;
    out["cancelFallbackEndsTurn"] = {
      endedAfterMs: Date.now() - cancelAt,
      pass: !session.getState().busy,
    };

    // 9. History parsing: order, versions, page-boundary dedupe, fragments
    // on the following user message, failed compactions, unknown types.
    const parsed = itemsFromMessages(
      [
        { type: "agent_message", rank: 5, version: 0, content: "old answer" },
        { type: "agent_message", rank: 5, version: 1, content: "edited answer", configuration: { name: "dust" } },
        { type: "user_message", rank: 4, content: "question" },
        { type: "content_fragment", rank: 3, title: "notes.pdf" },
        { type: "compaction_message", rank: 2, status: "failed" },
        { type: "something_new", rank: 1, content: "?" },
        { type: "user_message", rank: 9, content: "already on screen" },
      ],
      { agentName: "dust", beforeRank: 6 }
    );
    const kinds = parsed?.items.map((i) => i.kind).join(",");
    const user = parsed?.items.find((i) => i.kind === "user") as { attachments?: string[] } | undefined;
    const answer = parsed?.items.find((i) => i.kind === "agent-text") as { text?: string } | undefined;
    out["historyParsing"] = {
      kinds,
      minRank: parsed?.minRank,
      pass:
        kinds === "user,agent-header,agent-text" &&
        user?.attachments?.[0] === "notes.pdf" &&
        answer?.text === "edited answer" &&
        parsed?.minRank === 1 &&
        itemsFromMessages([{ type: "user_message" }], { agentName: "x" }) === null,
    };

    // 10. Agent markdown never loads an image from a URL (UNC / file / https).
    const { emit } = await import("./bus");
    emit({
      type: "transcript-reset",
      items: [
        {
          kind: "agent-text",
          id: "audit-img",
          streaming: false,
          text: "![unc](file://attacker/share/x.png) ![web](https://example.com/x.png) ![ok](data:image/png;base64,iVBORw0KGgo=)",
        },
      ],
    });
    await sleep(400);
    const imgs = (await run(`Array.from(document.querySelectorAll(".agent-body img")).map((i) => i.getAttribute("src"))`)) as string[];
    const shownAsLinks = (await run(`document.querySelectorAll(".agent-body a.md-image-link").length`)) as number;
    out["markdownImagesNeverFetch"] = {
      imgSrcs: imgs,
      shownAsLinks,
      pass: imgs.length === 0 && shownAsLinks === 3,
    };
    emit({ type: "transcript-reset", items: [] });

    // 11. Page script cannot name a path to attach: strings and script-built
    // Files carry no path, so nothing reaches main.
    await fresh();
    const beforeCount = session.getState().attachments.length;
    const bridge = (await run(`(async () => {
      const a = await window.dustm.attach.files(["C:/Windows/win.ini", "\\\\\\\\attacker\\\\share\\\\x.pdf"]);
      const b = await window.dustm.attach.files([new File(["x"], "fake.txt")]);
      return { a, b, legacy: typeof window.dustm.attach.paths, pathForFile: typeof window.dustm.pathForFile };
    })()`)) as { a: { value?: number }; b: { value?: number }; legacy: string; pathForFile: string };
    await sleep(200);
    out["bridgeRefusesMadeUpPaths"] = {
      ...bridge,
      attachmentsAdded: session.getState().attachments.length - beforeCount,
      pass:
        bridge.a.value === 2 &&
        bridge.b.value === 1 &&
        bridge.legacy === "undefined" &&
        bridge.pathForFile === "undefined" &&
        session.getState().attachments.length === beforeCount,
    };

    // 12. Oversized pasted image bytes are refused at the IPC boundary.
    const big = (await run(`window.dustm.attach.image(new Uint8Array(50 * 1024 * 1024 + 1), "image/png")`)) as { ok: boolean };
    out["pastedImageCapped"] = { ok: big.ok, pass: !big.ok && session.getState().attachments.length === beforeCount };

    // 13. A real OS-level file drop on the composer (DevTools protocol drag
    // events carry a real path) still attaches through the preload.
    await fresh();
    const rect = (await run(`(() => { const r = document.getElementById("composer").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`)) as { x: number; y: number };
    let dropError: string | null = null;
    try {
      wc.debugger.attach("1.3");
      const data = { items: [], files: [pkg], dragOperationsMask: 1 };
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await wc.debugger.sendCommand("Input.dispatchDragEvent", { type, x: rect.x, y: rect.y, data });
      }
    } catch (error) {
      dropError = error instanceof Error ? error.message : String(error);
    } finally {
      try {
        wc.debugger.detach();
      } catch {
        // not attached
      }
    }
    await uploadsSettled();
    const dropped = session.getState().attachments[0];
    out["realFileDropAttaches"] = {
      dropError,
      name: dropped?.name,
      status: dropped?.status,
      error: dropped?.error,
      pass: dropError === null && dropped?.name === fixtureName && dropped?.status === "ready",
    };
    await session.runCommand("clear-files", "");
  } finally {
    off();
    session.stopLoop("smoke done", { quiet: true });
    if (session.getState().busy) {
      await session.cancel();
      await idle(session.CANCEL_FALLBACK_MS + 3000);
    }
    session.setTestClient(null);
    session.newConversation();
    // Give the folder back (and release the temp one, which chdir holds on
    // Windows) before removing it.
    if (previousFolder) {
      session.setFolder(previousFolder, false);
    } else {
      process.chdir(os.tmpdir());
    }
    try {
      rmSync(auditDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  const all = Object.values(out).every((c) => c.pass);
  return { pass: all, ...out };
}

/**
 * `--smoke-delete-probe`: creates one EMPTY unlisted conversation (no message,
 * so no credits) and deletes it through the private endpoint the attachment
 * cleanup uses, then checks it is gone. Opt-in: it writes to the workspace.
 */
async function smokeDeleteProbe(): Promise<unknown> {
  const { getDustClient } = await import("../../../src/utils/dustClient");
  const { deleteConversationPrivate } = await import("./history");
  const clientRes = await getDustClient();
  const dust = clientRes.isOk() ? clientRes.value : null;
  if (!dust) return { pass: false, error: "not signed in" };
  const created = await dust.createConversation({
    title: "dustm desktop delete probe",
    visibility: "unlisted",
    contentFragments: [],
  });
  if (created.isErr()) return { pass: false, error: created.error.message };
  const id = created.value.conversation.sId;
  const deleted = await deleteConversationPrivate(id);
  const after = await dust.getConversation({ conversationId: id });
  const goneOrDeleted = after.isErr() || after.value.visibility === "deleted";
  return { deleted, goneOrDeleted, pass: deleted && goneOrDeleted };
}

/** `--smoke-btw=<question>`: one real side question; checks it never touches the main conversation. */
async function smokeBtw(question: string): Promise<unknown> {
  const session = await import("./session");
  let answer = "";
  let status = "";
  let mainPosted = false;
  const off = onSessionEvent((e) => {
    if (e.type === "patch" && "status" in e.patch && (e.patch as { answer?: string }).answer !== undefined) {
      status = String((e.patch as { status?: string }).status);
      answer = String((e.patch as { answer?: string }).answer);
    }
    // Anything appended as a user/agent turn would mean the main conversation was used.
    if (e.type === "append" && (e.item.kind === "user" || e.item.kind === "agent-header")) mainPosted = true;
  });
  const conversationBefore = session.getState().conversationId;
  const busyDuring: boolean[] = [];
  await session.runCommand("btw", question);
  const start = Date.now();
  while (session.getState().btwStatus !== null && Date.now() - start < 90_000) {
    busyDuring.push(session.getState().busy);
    await sleep(200);
  }
  off();
  return {
    status,
    answer: answer.slice(0, 120),
    mainConversationUntouched: session.getState().conversationId === conversationBefore && !mainPosted,
    mainEverBusy: busyDuring.some(Boolean),
    seconds: Math.round((Date.now() - start) / 1000),
  };
}

/**
 * `--smoke-escape`: opens each popover, drops focus out of it (the way a click
 * on the dialog's background does), presses Escape, and checks it closed with
 * focus back in the message box.
 */
async function smokeEscape(win: BrowserWindow): Promise<unknown> {
  const run = (js: string) => win.webContents.executeJavaScript(js, true);
  const results: Record<string, unknown> = {};
  const cases: Record<string, string> = {
    agentPicker: `document.querySelector("button.who").click()`,
    commandPalette: `window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))`,
    modelPicker: `document.querySelector("button.chip:not(.normal):not(.auto):not(.plan)").click()`,
    accountMenu: `document.querySelector("button.user-btn").click()`,
  };
  for (const [name, open] of Object.entries(cases)) {
    await run(open);
    await sleep(250);
    const opened = await run(`!!document.querySelector('[role="dialog"], [role="menu"]')`);
    await run(`document.activeElement && document.activeElement.blur()`); // focus leaves the popover
    await run(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
    await sleep(250);
    const closed = await run(`!document.querySelector('[role="dialog"], [role="menu"]')`);
    const focusInComposer = await run(`document.activeElement && document.activeElement.id === "composer"`);
    results[name] = { opened, closed, focusInComposer, pass: opened && closed && focusInComposer };
  }
  // The search box: Escape clears it.
  await run(`(() => { const el = document.getElementById("convo-search"); el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "zzz");
    el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await sleep(150);
  const noMatches = await run(`document.body.innerText.includes("no matches")`);
  await run(`document.getElementById("convo-search").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
  await sleep(150);
  results["searchBox"] = {
    noMatches,
    clearedByEscape: await run(`document.getElementById("convo-search").value === ""`),
  };
  return results;
}
