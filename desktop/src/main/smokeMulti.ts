import type { BrowserWindow } from "electron";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { areClaudeSkillsEnabled } from "../../../src/utils/skillStore";
import { isPlanModeActive } from "../../../src/utils/planMode";
import { getActiveConversationId } from "../../../src/utils/taskStore";
import type { SessionEvent } from "../shared/ipc";
import { onSessionEvent } from "./bus";
import {
  COALESCE_MS,
  DEFAULT_NOTIFY,
  activateForTest,
  mergeNotify,
  notificationsSupported,
  notifySession,
  setFocusProbeForTest,
  setNotifySinkForTest,
  toastOptions,
} from "./notify";
import type { NotifyRequest, ToastSpec } from "./notify";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `--smoke-multi`: parallel (background) sessions, against a stubbed Dust
 * client so no credits are spent. Self-contained: its own temp working folder,
 * and every scenario starts from a torn-down registry.
 *
 *   1. two sessions streaming at once, no cross-rendering (bus and renderer)
 *   2. plan mode in A and auto mode in B, both running: the write from A is
 *      refused and B's goes through (through each session's real tool set);
 *      the module-level singletons are never touched
 *   3. a background approval does not show in the foreground, and resolves
 *      after switching to it
 *   4. the concurrency cap queues the 4th turn, which starts when a slot frees
 *   5. sign-out tears down every session
 *   6. switching mid-load supersedes the load
 *   7. per-conversation busy gating (/compact) and per-session settings
 */
export async function smokeMulti(win: BrowserWindow): Promise<{ pass: boolean } & Record<string, unknown>> {
  const { Ok } = await import("@dust-tt/client");
  const session = await import("./session");
  const wc = win.webContents;
  const run = <T>(js: string) => wc.executeJavaScript(js, true) as Promise<T>;
  const out: Record<string, { pass: boolean } & Record<string, unknown>> = {};

  // ----------------------------------------------------------------- stub

  interface Gate {
    open: () => void;
    promise: Promise<void>;
  }
  const newGate = (): Gate => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open, promise };
  };
  interface Plan {
    label: string;
    /** Yield a Dust tool approval after the gate opens and wait for the answer. */
    approval?: boolean;
    /** Runs after the gate opens (and after the approval, if any). */
    hook?: (convId: string) => Promise<void>;
    /** After the gate: an agent error. */
    fail?: boolean;
    /** After the gate: a stream that never ends, even on abort (the SDK bug). */
    stuck?: boolean;
  }
  let convCounter = 0;
  const gates = new Map<string, Gate>();
  const decided = new Map<string, Gate>();
  const cancelGates = new Map<string, Gate>();
  const validated: Record<string, string> = {};
  const cancels: string[] = [];
  const createdConversations: string[] = [];
  const loadedConversations: string[] = [];
  let plans: { marker: string; plan: Plan }[] = [];
  let loadDelays: Record<string, number> = {};

  const planFor = (content: string): Plan =>
    plans.find((p) => content.includes(p.marker))?.plan ?? { label: content.slice(0, 20) };
  const convPlans = new Map<string, Plan>();
  const stuckConversations = new Set<string>();

  const fake = {
    createConversation: async (args: { message?: { content: string } }) => {
      const sId = `conv-multi-${++convCounter}`;
      createdConversations.push(sId);
      gates.set(sId, newGate());
      decided.set(sId, newGate());
      cancelGates.set(sId, newGate());
      convPlans.set(sId, planFor(args.message?.content ?? ""));
      return new Ok({ conversation: { sId, title: "t" }, message: args.message ? { sId: `u-${sId}` } : undefined });
    },
    postUserMessage: async () => new Ok({ sId: "u-post" }),
    postContentFragment: async () => new Ok({}),
    getConversation: async ({ conversationId }: { conversationId: string }) => {
      loadedConversations.push(conversationId);
      await sleep(loadDelays[conversationId] ?? 0);
      return new Ok({ sId: conversationId, title: `title of ${conversationId}`, content: [] });
    },
    streamAgentAnswerEvents: async ({
      conversation,
      signal,
    }: {
      conversation: { sId: string };
      signal?: AbortSignal;
    }) =>
      new Ok({
        eventStream: (async function* () {
          const convId = conversation.sId;
          const plan = convPlans.get(convId) ?? { label: convId };
          const messageId = `m-${convId}`;
          const aborted = new Promise<never>((_, reject) =>
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
          );
          yield { type: "generation_tokens", classification: "tokens", text: `${plan.label}-first `, messageId };
          if (plan.stuck) {
            await new Promise<never>(() => undefined);
          }
          const first = await Promise.race([
            gates.get(convId)?.promise.then(() => "go"),
            cancelGates.get(convId)?.promise.then(() => "cancel"),
            aborted,
          ]);
          if (first === "cancel") {
            yield { type: "agent_generation_cancelled", messageId };
            return;
          }
          if (plan.fail) {
            yield { type: "agent_error", error: { message: "boom" }, messageId };
            return;
          }
          if (plan.approval) {
            yield {
              type: "tool_approve_execution",
              conversationId: convId,
              messageId,
              actionId: `act-${convId}`,
              stake: "high",
              inputs: { command: "echo hi" },
              metadata: { toolName: "run_command", mcpServerName: "fs-cli" },
            };
            await Promise.race([decided.get(convId)?.promise, aborted]);
          }
          if (plan.hook) {
            await plan.hook(convId);
          }
          yield { type: "generation_tokens", classification: "tokens", text: `${plan.label}-second`, messageId };
          yield { type: "agent_message_success", message: { sId: messageId, content: "" } };
        })(),
      }),
    validateAction: async ({ actionId, approved }: { actionId: string; approved: string }) => {
      const convId = actionId.replace("act-", "");
      validated[convId] = approved;
      decided.get(convId)?.open();
      return new Ok({});
    },
    cancelMessageGeneration: async ({ conversationId }: { conversationId: string }) => {
      cancels.push(conversationId);
      if (!stuckConversations.has(conversationId)) cancelGates.get(conversationId)?.open();
      return new Ok({});
    },
    deleteConversation: async () => undefined,
  };

  // --------------------------------------------------------------- helpers

  const until = async (cond: () => boolean | Promise<boolean>, ms = 6000): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await cond()) return true;
      await sleep(40);
    }
    return false;
  };
  const keyOf = (convId: string): string | undefined =>
    session.getState().sessions.find((x) => x.conversationId === convId)?.key;
  const badge = (key: string) => session.getState().sessions.find((x) => x.key === key);
  const releaseAll = () => {
    for (const g of gates.values()) g.open();
    for (const g of decided.values()) g.open();
  };
  /** Opens a new chat, sends `text` and waits until its turn has a conversation id. */
  const startTurn = async (text: string): Promise<{ key: string; convId: string }> => {
    session.newConversation();
    const key = session.getSelectedKey();
    const sent = session.send(text);
    if (!sent.ok) throw new Error(`send refused: ${sent.error}`);
    await until(() => session.getSessionState(key)?.conversationId !== null || session.getSessionState(key)?.waitingForSlot === true);
    return { key, convId: session.getSessionState(key)?.conversationId ?? "" };
  };
  const fresh = async () => {
    releaseAll();
    await session.teardownSession();
    gates.clear();
    decided.clear();
    cancelGates.clear();
    stuckConversations.clear();
    convPlans.clear();
    plans = [];
    loadDelays = {};
    createdConversations.length = 0;
    loadedConversations.length = 0;
    cancels.length = 0;
    for (const k of Object.keys(validated)) delete validated[k];
    session.setMaxParallel(3, false);
    await sleep(60);
  };
  const view = () =>
    run<{ key: string | null; approval: string | null; running: number; title: string; statusbar: string; sidebar: string }>(
      "globalThis.__dustmView()"
    );
  const texts = () => run<string[]>("globalThis.__dustmItemTexts()");

  // Events as the bus sees them, to prove nothing from a background session
  // reaches the window.
  const events: { e: SessionEvent; at: number }[] = [];
  const off = onSessionEvent((e) => events.push({ e, at: Date.now() }));

  const dir = mkdtempSync(path.join(os.tmpdir(), "dustm-multi-"));
  const previousFolder = session.getState().folder;
  const previousMax = session.getMaxParallel();
  const folderSet = session.setFolder(dir, false);
  if (!folderSet.ok) {
    off();
    return { pass: false, error: `could not set the smoke folder: ${folderSet.error}` };
  }
  session.setTestClient(fake);

  try {
    // ---------------------------------------------- 1. parallel, no cross-render
    await fresh();
    plans = [
      { marker: "S1-alpha", plan: { label: "ALPHA" } },
      { marker: "S1-beta", plan: { label: "BETA" } },
    ];
    const a1 = await startTurn("S1-alpha please");
    const b1 = await startTurn("S1-beta please");
    const runningBoth = await until(() => session.getState().running === 2);
    await sleep(200);
    // Opening a conversation that is live (running in the background) is a
    // switch, not a refetch, and back again.
    const fetchesBefore = loadedConversations.length;
    await session.loadConversation(a1.convId);
    const switchedToLive = session.getSelectedKey() === a1.key;
    session.selectSession(b1.key);
    const reopenedFetches = loadedConversations.length - fetchesBefore;
    await sleep(150);
    const mark = Date.now();
    releaseAll();
    await until(() => session.getSessionState(a1.key)?.busy === false && session.getSessionState(b1.key)?.busy === false);
    await sleep(300);
    const afterSwitch = events.filter((x) => x.at >= mark && "sid" in x.e && x.e.sid !== undefined);
    const foreign = afterSwitch.filter((x) => "sid" in x.e && x.e.sid !== b1.key);
    const renderedB = (await texts()).join("|");
    const toA = await run<{ ok: boolean }>(`window.dustm.selectSession(${JSON.stringify(a1.key)})`);
    await sleep(250);
    const renderedA = (await texts()).join("|");
    const viewAfter = await view();
    out["twoSessionsStreamingNoCrossRender"] = {
      runningBoth,
      switchedToLiveWithoutFetch: switchedToLive && reopenedFetches === 0,
      foreignEventsAfterSwitch: foreign.length,
      selectedShowsOnlyItsOwn: renderedB.includes("BETA-first") && !renderedB.includes("ALPHA"),
      otherShowsOnlyItsOwnAfterSwitch: renderedA.includes("ALPHA-first") && renderedA.includes("ALPHA-second") && !renderedA.includes("BETA"),
      switchOk: toA.ok && viewAfter.key === a1.key,
      pass:
        runningBoth &&
        switchedToLive &&
        reopenedFetches === 0 &&
        foreign.length === 0 &&
        renderedB.includes("BETA-first") &&
        renderedB.includes("BETA-second") &&
        !renderedB.includes("ALPHA") &&
        renderedA.includes("ALPHA-second") &&
        !renderedA.includes("BETA") &&
        toA.ok &&
        viewAfter.key === a1.key,
    };

    // ---------------------------------------------- 2. plan in A, auto in B
    await fresh();
    const fileA = path.join(dir, "from-plan-session.txt");
    const fileB = path.join(dir, "from-auto-session.txt");
    const toolResults: Record<string, unknown> = {};
    let keyA = "";
    let keyB = "";
    const call = async (key: string, tool: string, args: Record<string, unknown>) => {
      const tools = session.sessionToolsForTest(key) as Record<string, { execute: (a: never) => Promise<unknown> }>;
      return tools[tool].execute(args as never);
    };
    plans = [
      {
        marker: "S2-plan-session",
        plan: {
          label: "PLAN",
          hook: async () => {
            toolResults["A.write_file"] = await call(keyA, "write_file", { path: fileA, content: "from A" });
            toolResults["A.edit_file"] = await call(keyA, "edit_file", { path: fileA, old_string: "x", new_string: "y" });
            toolResults["A.run_command"] = await call(keyA, "run_command", { command: "node", args: ["-v"] });
          },
        },
      },
      {
        marker: "S2-auto-session",
        plan: {
          label: "AUTO",
          hook: async () => {
            toolResults["B.write_file"] = await call(keyB, "write_file", { path: fileB, content: "from B" });
          },
        },
      },
    ];
    session.newConversation();
    keyA = session.getSelectedKey();
    session.setMode("plan");
    session.send("S2-plan-session go");
    await until(() => session.getSessionState(keyA)?.busy === true);
    session.newConversation();
    keyB = session.getSelectedKey();
    session.setMode("auto");
    session.send("S2-auto-session go");
    await until(() => session.getSessionState(keyB)?.busy === true);
    const bothBusy = session.getState().running === 2;
    const modes = { a: session.getSessionState(keyA)?.mode, b: session.getSessionState(keyB)?.mode };
    // Both turns are now running (A in plan mode, B in auto): let both tool
    // sequences fire at once.
    releaseAll();
    await until(() => session.getState().running === 0, 8000);
    const text = (r: unknown): string => JSON.stringify(r);
    const aWrite = toolResults["A.write_file"] as { isError?: boolean } | undefined;
    const aEdit = toolResults["A.edit_file"] as { isError?: boolean } | undefined;
    const aRun = toolResults["A.run_command"] as { isError?: boolean } | undefined;
    const bWrite = toolResults["B.write_file"] as { isError?: boolean } | undefined;
    const fileAExists = existsSync(fileA);
    const fileBContent = existsSync(fileB) ? readFileSync(fileB, "utf-8") : null;
    // Per-session tasks through each session's own context, not the singleton
    // (A and B are both still alive: A finished unseen, B is on screen).
    await call(keyA, "todo_write", { todos: [{ id: "t1", content: "A task", status: "pending" }] });
    const tasksA = session.getSessionState(keyA)?.tasks ?? [];
    const tasksB = session.getSessionState(keyB)?.tasks ?? [];
    for (const id of createdConversations) {
      try {
        unlinkSync(path.join(os.homedir(), ".dust-cli", "tasks", `${id}.json`));
      } catch {
        // not written for this one
      }
    }
    // A flip is live and per session: B to plan blocks B, A unaffected.
    session.setMode("plan");
    const flipped = (await call(keyB, "write_file", { path: fileA, content: "late" })) as { isError?: boolean };
    const flippedAUnchanged = session.getSessionState(keyA)?.mode === "plan";
    out["planAndAutoAreIsolated"] = {
      bothBusy,
      modes,
      planWriteRefused: aWrite?.isError === true && /plan mode/i.test(text(aWrite)),
      planEditRefused: aEdit?.isError === true && /plan mode/i.test(text(aEdit)),
      planRunCommandRefused: aRun?.isError === true && /plan mode/i.test(text(aRun)),
      planFileNotWritten: !fileAExists,
      autoWriteWentThrough: bWrite?.isError !== true && fileBContent === "from B",
      tasksStayInTheirSession: tasksA.length === 1 && tasksB.length === 0,
      modeChangeIsLiveAndPerSession: flipped?.isError === true && flippedAUnchanged,
      singletonsUntouched: !isPlanModeActive() && getActiveConversationId() === null && !areClaudeSkillsEnabled(),
      pass:
        bothBusy &&
        modes.a === "plan" &&
        modes.b === "auto" &&
        aWrite?.isError === true &&
        /plan mode/i.test(text(aWrite)) &&
        aEdit?.isError === true &&
        aRun?.isError === true &&
        !fileAExists &&
        bWrite?.isError !== true &&
        fileBContent === "from B" &&
        tasksA.length === 1 &&
        tasksB.length === 0 &&
        flipped?.isError === true &&
        flippedAUnchanged &&
        !isPlanModeActive() &&
        getActiveConversationId() === null &&
        !areClaudeSkillsEnabled(),
    };

    // ---------------------------------------------- 3. background approval
    await fresh();
    plans = [
      { marker: "S3-needs-approval", plan: { label: "APPR", approval: true } },
      { marker: "S3-other", plan: { label: "OTHER" } },
    ];
    const a3 = await startTurn("S3-needs-approval run something");
    // Away from A *before* it asks, so the request arrives in the background.
    session.newConversation();
    const b3key = session.getSelectedKey();
    gates.get(a3.convId)?.open();
    const asked = await until(() => badge(a3.key)?.status === "approval");
    await sleep(250);
    const viewDuring = await view();
    const stateDuring = session.getState();
    // The foreground is free: B can run a whole turn while A waits.
    session.send("S3-other hello");
    await until(() => session.getSessionState(b3key)?.conversationId !== null);
    const b3conv = session.getSessionState(b3key)?.conversationId ?? "";
    gates.get(b3conv)?.open();
    const bDone = await until(() => session.getSessionState(b3key)?.busy === false && badge(b3key)?.status === "idle");
    const stillWaiting = badge(a3.key)?.status === "approval";
    // Opening it shows the dialog.
    await run(`window.dustm.selectSession(${JSON.stringify(a3.key)})`);
    await sleep(250);
    const viewOpen = await view();
    const resolved = viewOpen.approval
      ? await run<{ ok: boolean }>(`window.dustm.resolveApproval(${JSON.stringify(viewOpen.approval)}, { kind: "approve" })`)
      : { ok: false };
    const aDone = await until(() => session.getSessionState(a3.key)?.busy === false);
    out["backgroundApprovalWaitsOnItsSession"] = {
      requestedInBackground: asked,
      foregroundSelectedIsB: viewDuring.key === b3key && stateDuring.sessionKey === b3key,
      noDialogOverForeground: viewDuring.approval === null,
      sidebarHasNeedsYou: /needs you/.test(viewDuring.sidebar),
      titleSaysSomethingWaits: /waiting for you/.test(viewDuring.title),
      foregroundTurnFinishedWhileWaiting: bDone,
      stillWaitingAfterForegroundFinished: stillWaiting,
      dialogShownOnOpen: viewOpen.approval !== null,
      resolveOk: resolved.ok,
      agentSawApproved: validated[a3.convId] === "approved",
      turnCompleted: aDone,
      pass:
        asked &&
        viewDuring.key === b3key &&
        viewDuring.approval === null &&
        /needs you/.test(viewDuring.sidebar) &&
        /waiting for you/.test(viewDuring.title) &&
        bDone &&
        stillWaiting &&
        viewOpen.approval !== null &&
        resolved.ok &&
        validated[a3.convId] === "approved" &&
        aDone,
    };

    // ---------------------------------------------- 4. the cap queues the 4th
    await fresh();
    const started: { key: string; convId: string }[] = [];
    for (let i = 1; i <= 3; i++) {
      plans.push({ marker: `S4-turn-${i}`, plan: { label: `T${i}` } });
      started.push(await startTurn(`S4-turn-${i}`));
    }
    plans.push({ marker: "S4-turn-4", plan: { label: "T4" } });
    session.newConversation();
    const key4 = session.getSelectedKey();
    session.send("S4-turn-4");
    await sleep(300);
    const viewCap = await view();
    const state4 = session.getSessionState(key4);
    const waitingClear =
      state4?.waitingForSlot === true &&
      state4.queue.length === 1 &&
      badge(key4)?.status === "waiting-slot" &&
      /waiting for a free slot/.test(viewCap.sidebar);
    const apiCallsAtCap = createdConversations.length;
    const runningAtCap = session.getState().running;
    gates.get(started[0].convId)?.open();
    const fourthStarted = await until(() => session.getSessionState(key4)?.busy === true);
    const apiCallsAfter = createdConversations.length;
    const runningAfter = session.getState().running;
    // A raised cap releases waiters too: queue one more, then raise to 5.
    plans.push({ marker: "S4-turn-5", plan: { label: "T5" } });
    session.newConversation();
    const key5 = session.getSelectedKey();
    session.send("S4-turn-5");
    await sleep(150);
    const fifthWaits = session.getSessionState(key5)?.waitingForSlot === true;
    session.setMaxParallel(5, false);
    const fifthStarted = await until(() => session.getSessionState(key5)?.busy === true);
    out["capQueuesTheFourthTurn"] = {
      runningAtCap,
      apiCallsAtCap,
      waitingStateClear: waitingClear,
      statusbarShowsRunning: /3 running/.test(viewCap.statusbar),
      fourthStartedWhenSlotFreed: fourthStarted,
      runningAfter,
      apiCallsAfter,
      fifthWaited: fifthWaits,
      raisingTheCapStartedIt: fifthStarted,
      pass:
        runningAtCap === 3 &&
        apiCallsAtCap === 3 &&
        waitingClear &&
        /3 running/.test(viewCap.statusbar) &&
        fourthStarted &&
        runningAfter === 3 &&
        apiCallsAfter === 4 &&
        fifthWaits &&
        fifthStarted,
    };

    // ---------------------------------------------- 5. sign-out tears down all
    await fresh();
    plans = [
      { marker: "S5-run-1", plan: { label: "R1" } },
      { marker: "S5-approve", plan: { label: "R2", approval: true } },
      { marker: "S5-run-3", plan: { label: "R3" } },
      { marker: "S5-queued", plan: { label: "R4" } },
    ];
    const closed: string[] = [];
    const s5a = await startTurn("S5-run-1");
    session.setFsServerForTest("fs-a", async () => void closed.push("a"));
    await session.runCommand("loop", "30s x3 S5-run-1 tick");
    const s5b = await startTurn("S5-approve");
    session.setFsServerForTest("fs-b", async () => void closed.push("b"));
    gates.get(s5b.convId)?.open();
    await until(() => badge(s5b.key)?.status === "approval");
    const s5c = await startTurn("S5-run-3");
    session.setFsServerForTest("fs-c", async () => void closed.push("c"));
    session.newConversation();
    const s5dKey = session.getSelectedKey();
    session.send("S5-queued");
    await sleep(250);
    const before = session.getState();
    const createdBefore = createdConversations.length;
    await session.teardownSession();
    await sleep(300);
    releaseAll();
    await sleep(500);
    const after = session.getState();
    const viewAfterTeardown = await view();
    out["signOutTearsDownEverySession"] = {
      sessionsBefore: before.sessions.length,
      runningBefore: before.running,
      waitingBefore: session.getSessionState(s5dKey) === null ? "gone" : "present",
      serverCancelledEach: [s5a, s5b, s5c].every((x) => cancels.includes(x.convId)),
      cancelCount: cancels.length,
      fsServersClosed: closed.sort().join(","),
      sessionsAfter: after.sessions.length,
      runningAfter: after.running,
      loopAfter: after.loop,
      noDialogAfter: viewAfterTeardown.approval === null,
      noTurnStartedAfter: createdConversations.length === createdBefore,
      selectedIsFresh: after.conversationId === null && viewAfterTeardown.key === after.sessionKey,
      pass:
        before.sessions.length >= 4 &&
        before.running === 3 &&
        [s5a, s5b, s5c].every((x) => cancels.includes(x.convId)) &&
        closed.sort().join(",") === "a,b,c" &&
        after.sessions.length === 1 &&
        after.running === 0 &&
        after.loop === null &&
        viewAfterTeardown.approval === null &&
        createdConversations.length === createdBefore &&
        after.conversationId === null &&
        viewAfterTeardown.key === after.sessionKey,
    };

    // ---------------------------------------------- 6. switching mid-load
    await fresh();
    loadDelays = { "conv-slow": 700, "conv-fast": 40, "conv-slow-2": 700 };
    const slow = session.loadConversation("conv-slow");
    await sleep(120);
    const loadingShown = session.getState().loadingConversationId === "conv-slow";
    const fast = await session.loadConversation("conv-fast");
    const slowResult = await slow;
    await sleep(250);
    const afterFast = session.getState();
    const slowSessionExists = session.getState().sessions.some((x) => x.conversationId === "conv-slow");
    // A new chat supersedes a load as well.
    const slow2 = session.loadConversation("conv-slow-2");
    await sleep(120);
    session.newConversation();
    await slow2;
    await sleep(300);
    const afterNew = session.getState();
    // Selecting a live session supersedes it too.
    const keyFast = session.getState().sessions.find((x) => x.conversationId === "conv-fast")?.key;
    out["switchingMidLoadSupersedesIt"] = {
      loadingShown,
      fastOk: fast.ok,
      slowResolvedWithoutError: slowResult.ok,
      selectedIsFast: afterFast.conversationId === "conv-fast",
      slowNeverMaterialised: !slowSessionExists,
      loadingCleared: afterFast.loadingConversationId === null,
      newChatSupersedes: afterNew.conversationId === null && afterNew.loadingConversationId === null && !afterNew.sessions.some((x) => x.conversationId === "conv-slow-2"),
      pass:
        loadingShown &&
        fast.ok &&
        slowResult.ok &&
        afterFast.conversationId === "conv-fast" &&
        !slowSessionExists &&
        afterFast.loadingConversationId === null &&
        afterNew.conversationId === null &&
        afterNew.loadingConversationId === null &&
        !afterNew.sessions.some((x) => x.conversationId === "conv-slow-2") &&
        keyFast === undefined, // the idle conv-fast session was retired when we left it
    };

    // ---------------------------------------------- 7. per-conversation gating & settings
    await fresh();
    plans = [{ marker: "S7-busy", plan: { label: "BUSY" } }];
    const busy7 = await startTurn("S7-busy go");
    // A conversation opened from history, next to the busy one.
    await session.loadConversation("conv-idle");
    session.setEffort("high");
    session.setMode("auto");
    const idleAgentBefore = session.getState().agentId;
    // Leaving an idle session retires it, but what the user chose for that
    // conversation (mode, effort, agent) is remembered for a reopen.
    session.selectSession(busy7.key);
    const effortBusy = session.getState().effort;
    const modeBusy = session.getState().mode;
    // /compact on the busy conversation is refused with its own message...
    await session.runCommand("compact", "");
    await sleep(300);
    const busyTexts = (await texts()).join("|");
    const busyNotCompacting = session.getState().compacting === null;
    // ...and the busy one does not block the idle one: it marks itself
    // compacting before its first await (the rest needs the network and may
    // end early with a note, which is fine here).
    await session.loadConversation("conv-idle");
    const reopened = session.getState();
    await session.runCommand("compact", "");
    const idleCompacting = session.getState().compacting !== null;
    await until(() => session.getState().compacting === null, 20_000);
    const otherAgent = session.getState().agents.find((x) => x.sId !== idleAgentBefore)?.sId ?? null;
    let agentsIsolated = true;
    if (otherAgent) {
      session.selectAgent(otherAgent, false);
      const idleAgent = session.getState().agentId;
      session.selectSession(busy7.key);
      agentsIsolated = idleAgent === otherAgent && session.getState().agentId === idleAgentBefore;
      session.selectAgent(idleAgentBefore ?? otherAgent, false);
    }
    releaseAll();
    out["perConversationGatingAndSettings"] = {
      busyConversationRefusedItsOwnCompact: /still working/.test(busyTexts) && busyNotCompacting,
      idleConversationCompactNotBlocked: idleCompacting,
      effortIsPerSession: effortBusy === null && reopened.effort === "high",
      modeIsPerSessionAndRememberedForAReopen: modeBusy === "normal" && reopened.mode === "auto",
      agentIsPerSession: agentsIsolated,
      pass:
        /still working/.test(busyTexts) &&
        busyNotCompacting &&
        idleCompacting &&
        effortBusy === null &&
        reopened.effort === "high" &&
        modeBusy === "normal" &&
        reopened.mode === "auto" &&
        agentsIsolated,
    };

    // ---------------------------------------------- 8. notifications
    await fresh();
    const toasts: ToastSpec[] = [];
    let focused = true;
    setNotifySinkForTest((t) => void toasts.push(t));
    setFocusProbeForTest(() => focused);
    const previousNotify = session.getState().notify;
    session.setNotify(DEFAULT_NOTIFY as unknown as Record<string, unknown>);
    const settle = (ms = COALESCE_MS + 350) => sleep(ms);
    const take = () => toasts.splice(0, toasts.length);

    // (a) the visible, focused conversation never notifies; (b) the same turn
    // with the window unfocused does.
    plans = [{ marker: "S8-visible", plan: { label: "VIS" } }];
    const v = await startTurn("S8-visible go");
    gates.get(v.convId)?.open();
    await until(() => session.getSessionState(v.key)?.busy === false);
    await settle();
    const visibleFocused = take();
    plans = [{ marker: "S8-unfocused", plan: { label: "UNF" } }];
    focused = false;
    const u = await startTurn("S8-unfocused go");
    gates.get(u.convId)?.open();
    await until(() => session.getSessionState(u.key)?.busy === false);
    await settle();
    const unfocusedSelected = take();
    focused = true;

    // (c) a background conversation finishing, window focused.
    await fresh();
    plans = [{ marker: "S8-bg", plan: { label: "BGDONE" } }];
    const bg = await startTurn("S8-bg go");
    session.newConversation();
    gates.get(bg.convId)?.open();
    await until(() => badge(bg.key)?.status === "finished");
    await settle();
    const backgroundFinished = take();
    // Clicking the toast selects that conversation.
    activateForTest(bg.key);
    const clickSelects = session.getSelectedKey() === bg.key;

    // (d) a background approval, (e) a background error.
    await fresh();
    plans = [
      { marker: "S8-appr", plan: { label: "APPR", approval: true } },
      { marker: "S8-fail", plan: { label: "FAIL", fail: true } },
    ];
    const ap = await startTurn("S8-appr go");
    const fl = await startTurn("S8-fail go");
    session.newConversation();
    gates.get(ap.convId)?.open();
    await until(() => badge(ap.key)?.status === "approval");
    await settle();
    const approvalToast = take();
    gates.get(fl.convId)?.open();
    await until(() => badge(fl.key)?.status === "error");
    await settle();
    const errorToast = take();
    decided.get(ap.convId)?.open();
    releaseAll();

    // (f) delivery matrix, straight through the policy and the coalescer.
    let n8 = 0;
    const fire = async (kind: NotifyRequest["kind"], cfg: ReturnType<typeof mergeNotify>) => {
      notifySession(
        { kind, key: `k${++n8}`, agentName: "Agent", conversationTitle: "Title", summary: "x", selected: false },
        cfg
      );
      await settle();
      return take();
    };
    const base = mergeNotify(DEFAULT_NOTIFY, {});
    const popupOnly = await fire("finished", mergeNotify(base, { finished: { popup: true, sound: "none" } }));
    const soundOnly = await fire("finished", mergeNotify(base, { finished: { popup: false, sound: "mantu" } }));
    const both = await fire("approval", mergeNotify(base, { approval: { popup: true, sound: "two-tone" } }));
    const kindOff = await fire("error", mergeNotify(base, { error: { popup: false, sound: "none" } }));
    const kindIndependent = await fire("finished", mergeNotify(base, { error: { popup: false, sound: "none" } }));
    const masterOff = await fire("approval", mergeNotify(base, { enabled: false }));
    const junk = mergeNotify(base, { volume: 7, finished: { sound: "nonsense", popup: "yes" } });

    // (g) a burst is one toast and one sound.
    for (let i = 0; i < 3; i++) {
      notifySession(
        { kind: i === 0 ? "approval" : "finished", key: `burst${i}`, agentName: "Agent", conversationTitle: `T${i}`, summary: "", selected: false },
        base
      );
    }
    await settle();
    const burst = take();

    // (h) content stays short; (i) the toast itself is always silent.
    const long = "SECRET ".repeat(80);
    const shortened = await fire("finished", { ...base });
    notifySession(
      { kind: "error", key: "long", agentName: "Agent", conversationTitle: long, summary: long, selected: false },
      base
    );
    await settle();
    const longToast = take()[0];
    const everySpec: ToastSpec[] = [...backgroundFinished, ...approvalToast, ...errorToast, ...both, ...burst];
    const silentToasts = everySpec.length > 0 && everySpec.every((t) => toastOptions(t).silent === true);

    // (j) the page can play a tone with the window hidden and unfocused.
    const audioStarts = await run<boolean>("globalThis.__dustmPlaySound('ping', 0.01)");

    out["notificationsFireOnTheRightEvents"] = {
      notificationSupported: notificationsSupported(),
      visibleFocusedSilent: visibleFocused.length === 0,
      selectedButWindowUnfocusedNotifies: unfocusedSelected.length === 1 && unfocusedSelected[0].kinds[0] === "finished",
      backgroundFinishedNotifies: backgroundFinished.length === 1 && backgroundFinished[0].kinds[0] === "finished",
      clickSelectsTheConversation: clickSelects,
      backgroundApprovalNotifies: approvalToast.some((t) => t.kinds.includes("approval")),
      errorNotifies: errorToast.some((t) => t.kinds.includes("error")),
      pass:
        visibleFocused.length === 0 &&
        unfocusedSelected.length === 1 &&
        backgroundFinished.length === 1 &&
        backgroundFinished[0].title.length > 0 &&
        clickSelects &&
        approvalToast.some((t) => t.kinds.includes("approval")) &&
        errorToast.some((t) => t.kinds.includes("error")),
    };
    out["notificationChannelsFollowSettings"] = {
      popupOnly: popupOnly[0] ? { popup: popupOnly[0].popup, sound: popupOnly[0].sound } : null,
      soundOnly: soundOnly[0] ? { popup: soundOnly[0].popup, sound: soundOnly[0].sound } : null,
      both: both[0] ? { popup: both[0].popup, sound: both[0].sound } : null,
      kindOffFires: kindOff.length,
      otherKindUnaffected: kindIndependent.length === 1,
      masterOffFires: masterOff.length,
      hostileSettingsClamped: junk.volume === 1 && junk.finished.sound === base.finished.sound && junk.finished.popup === base.finished.popup,
      burstToasts: burst.length,
      burstCovers: burst[0]?.kinds.length ?? 0,
      burstSound: burst[0]?.sound ?? null,
      toastsAreSilent: silentToasts,
      toastBodyLength: longToast?.body.length ?? null,
      toastLeaksLongText: (longToast?.body.length ?? 0) > 160 || /SECRET (SECRET ){30}/.test(longToast?.body ?? ""),
      shortenedOk: shortened.length === 1,
      audioStartsWhileHidden: audioStarts,
      pass:
        popupOnly.length === 1 && popupOnly[0].popup && popupOnly[0].sound === "none" &&
        soundOnly.length === 1 && !soundOnly[0].popup && soundOnly[0].sound === "mantu" &&
        both.length === 1 && both[0].popup && both[0].sound === "two-tone" &&
        kindOff.length === 0 &&
        kindIndependent.length === 1 &&
        masterOff.length === 0 &&
        junk.volume === 1 && junk.finished.sound === base.finished.sound && junk.finished.popup === base.finished.popup &&
        burst.length === 1 && burst[0].kinds.length === 3 && burst[0].sound === "two-tone" &&
        silentToasts &&
        !!longToast && longToast.body.length <= 160 && !/SECRET (SECRET ){30}/.test(longToast.body) &&
        audioStarts === true,
    };
    setNotifySinkForTest(() => undefined);
    setFocusProbeForTest(null);
    session.setNotify(previousNotify as unknown as Record<string, unknown>);

    // ---------------------------------------------- 9. stopping is deliberate
    await fresh();
    plans = [{ marker: "S9-esc", plan: { label: "ESC" } }];
    const esc = (el: string, extra = "") =>
      run(`document.querySelector(${JSON.stringify(el)}).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true${extra} }))`);
    session.newConversation();
    await run(`(async () => {
      const el = document.getElementById("composer"); el.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, "S9-esc go");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    })()`);
    const escKey = session.getSelectedKey();
    await until(() => session.getSessionState(escKey)?.busy === true);
    // Enter, then an immediate click and double-click where Send was.
    await until(async () => (await run<boolean>('!!document.querySelector("button.send.stop")')));
    await run('(() => { const b = document.querySelector("button.send.stop"); b.click(); b.click(); b.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 })); })()');
    await sleep(300);
    const afterClicks = { cancels: cancels.length, busy: session.getSessionState(escKey)?.busy };
    // Esc that closes a popover must not cancel.
    await run('window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))');
    await sleep(200);
    const paletteOpened = await run<boolean>('!!document.querySelector("[role=dialog]")');
    await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))');
    await sleep(200);
    const paletteClosed = await run<boolean>('!document.querySelector("[role=dialog]")');
    const afterPopoverEsc = cancels.length;
    // A single Esc in the composer shows a hint and does not cancel; a
    // repeating key never counts; a second Esc within 1.5 s does.
    await esc("#composer");
    await sleep(150);
    const hint = await run<boolean>('/Press Esc again/.test(document.body.innerText)');
    const afterSingle = cancels.length;
    await esc("#composer", ", repeat: true");
    await sleep(100);
    const afterRepeat = cancels.length;
    await sleep(1700);
    await esc("#composer");
    await sleep(100);
    const afterSlowPair = cancels.length;
    await esc("#composer");
    await until(() => session.getSessionState(escKey)?.busy === false, 6000);
    await sleep(300);
    const afterDouble = cancels.length;
    const stopped = (await texts()).some((t) => /Stopped by you/.test(t));
    const noThinking = await run<boolean>('!document.querySelector(".thinking-row")');
    const st = session.getSessionState(escKey);

    // A stream that ignores the abort (the SDK bug) must still end the turn.
    plans = [{ marker: "S9-stuck", plan: { label: "STUCK", stuck: true } }];
    const stuck = await startTurn("S9-stuck go");
    stuckConversations.add(stuck.convId);
    const t0 = Date.now();
    await session.cancel("smoke");
    await until(() => session.getSessionState(stuck.key)?.busy === false, session.CANCEL_FALLBACK_MS + 4000);
    const stuckEnded = session.getSessionState(stuck.key)?.busy === false;
    await sleep(300);
    const stuckStopped = (await texts()).some((t) => /Stopped by you/.test(t));
    const stuckNoThinking = await run<boolean>('!document.querySelector(".thinking-row")');
    const stuckState = session.getSessionState(stuck.key);
    out["stoppingIsDeliberate"] = {
      clickRightAfterEnterIgnored: afterClicks.cancels === 0 && afterClicks.busy === true,
      popoverOpened: paletteOpened,
      escClosingAPopoverDoesNotCancel: paletteClosed && afterPopoverEsc === 0,
      singleEscShowsHintOnly: hint && afterSingle === 0,
      repeatingEscIgnored: afterRepeat === 0,
      escPairTooSlowIgnored: afterSlowPair === 0,
      doubleEscCancels: afterDouble === 1,
      stoppedNoteShown: stopped,
      noThinkingRowAfterStop: noThinking && st?.pendingAgent === null && st?.thinking === false,
      stuckStreamEndedAfterMs: Date.now() - t0,
      stuckStreamEnds: stuckEnded && stuckState?.pendingAgent === null && stuckState?.thinking === false,
      stuckShowsStopped: stuckStopped,
      stuckNoThinkingRow: stuckNoThinking,
      pass:
        afterClicks.cancels === 0 && afterClicks.busy === true &&
        paletteOpened && paletteClosed && afterPopoverEsc === 0 &&
        hint && afterSingle === 0 && afterRepeat === 0 && afterSlowPair === 0 &&
        afterDouble === 1 && stopped && noThinking &&
        st?.pendingAgent === null && st?.thinking === false &&
        stuckEnded && stuckStopped && stuckNoThinking &&
        stuckState?.pendingAgent === null && stuckState?.thinking === false,
    };

    // ------------------------------- 10. second-pass review regressions
    // (a) A stop aimed at one session (the renderer passes the key it was
    //     showing) must not land on the session that is on screen by the
    //     time it arrives.
    await fresh();
    plans = [{ marker: "S10-held", plan: { label: "HELD" } }];
    const held = await startTurn("S10-held go");
    await until(() => session.getSessionState(held.key)?.busy === true);
    session.newConversation();
    const otherKey = session.getSelectedKey();
    const staleStop = await session.cancel("smoke", held.key);
    await sleep(200);
    const heldStillBusy = session.getSessionState(held.key)?.busy === true;
    const cancelsAfterStale = cancels.length;
    // (b) A retired session's tools fail closed: in auto mode, after it is
    //     disposed, run_command and write_file are refused as in plan mode,
    //     never run with stale permissions.
    const retiredKey = session.getSelectedKey(); // the empty draft from (a)
    session.setMode("auto");
    const retiredTools = session.sessionToolsForTest(retiredKey) as Record<string, { execute: (a: never) => Promise<unknown> }>;
    // Leaving an idle draft retires it.
    session.selectSession(held.key);
    const retiredGone = session.getSessionState(retiredKey) === null;
    const retiredFile = path.join(dir, "from-retired-session.txt");
    const rc = (await retiredTools["run_command"].execute({ command: "node", args: ["-v"] } as never)) as { isError?: boolean; content?: { text?: string }[] };
    const wf = (await retiredTools["write_file"].execute({ path: retiredFile, content: "x" } as never)) as { isError?: boolean; content?: { text?: string }[] };
    const refused = (r: typeof rc) => r.isError === true && /plan mode/i.test(r.content?.[0]?.text ?? "");
    releaseAll();
    await until(() => session.getSessionState(held.key)?.busy === false);
    out["reviewFixes"] = {
      staleStopRefused: !staleStop.ok && heldStillBusy && cancelsAfterStale === 0,
      otherKeyDiffers: otherKey !== held.key,
      retiredGone,
      retiredRunCommandRefused: refused(rc),
      retiredWriteRefused: refused(wf) && !existsSync(retiredFile),
      pass:
        !staleStop.ok && heldStillBusy && cancelsAfterStale === 0 &&
        otherKey !== held.key && retiredGone &&
        refused(rc) && refused(wf) && !existsSync(retiredFile),
    };
  } catch (error) {
    out["error"] = { pass: false, message: error instanceof Error ? error.stack ?? error.message : String(error) };
  } finally {
    releaseAll();
    off();
    await session.teardownSession();
    session.setTestClient(null);
    session.setMaxParallel(previousMax, false);
    if (previousFolder) {
      session.setFolder(previousFolder, false);
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // temp folder; the OS cleans it up
    }
  }

  const pass = Object.values(out).every((x) => x.pass);
  return { pass, ...out };
}
