import type {
  AgentActionSpecificEvent,
  CreateConversationResponseType,
  DustAPI,
  GetAgentConfigurationsResponseType,
  MeResponseType,
} from "@dust-tt/client";
import { globIterate } from "glob";
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";

import { askBtw } from "../../../src/utils/btw";
import type { ClaudeContext } from "../../../src/utils/claudeMemory";
import {
  buildPrimingBlock,
  hasAnyContext,
  loadClaudeContext,
  summarizeContext,
} from "../../../src/utils/claudeMemory";
import { getClipboardImagePath } from "../../../src/utils/clipboardImage";
import {
  startCompaction,
  waitForCompaction,
} from "../../../src/utils/compactionService";
import {
  MAX_FILE_SIZE,
  formatFileSize,
  getMimeType,
  isImageFile,
  validateAndGetFileInfo,
} from "../../../src/utils/fileHandling";
import type { LoopState } from "../../../src/utils/loopController";
import {
  describeLoop,
  formatInterval,
  parseLoopCommand,
} from "../../../src/utils/loopController";
import type { Skill } from "../../../src/utils/skillStore";
import {
  buildSkillCatalogue,
  buildSkillsBlock,
  loadSkills,
  resolveSkill,
  saveDisabledSkillNames,
  summarizeSkills,
} from "../../../src/utils/skillStore";

import { buildFsTools, useFileSystemServer } from "../../../src/mcp/servers/fsServer";
import type { ToolContext } from "../../../src/mcp/toolContext";
import { agentCache } from "../../../src/utils/agentCache";
import AuthService from "../../../src/utils/authService";
import type { ChatMode as CliChatMode } from "../../../src/utils/chatMode";
import { nextChatMode } from "../../../src/utils/chatMode";
import { getContextUsage } from "../../../src/utils/contextUsage";
import { getConsumedCredits } from "../../../src/utils/creditsInfo";
import { getDustClient } from "../../../src/utils/dustClient";
import { normalizeError } from "../../../src/utils/errors";
import { getGitBranch } from "../../../src/utils/gitInfo";
import type { ModelChoice } from "../../../src/utils/modelSelection";
import {
  MODEL_CATALOG,
  buildModelSelection,
  resolveCompactionModel,
  resolveModel,
} from "../../../src/utils/modelSelection";
import type { PlanDecision } from "../../../src/utils/planMode";
import {
  PLAN_MODE_BLOCKED_TOOLS,
  planModePreamble,
  planModeReminder,
} from "../../../src/utils/planMode";
import { saveApprovedPlan } from "../../../src/utils/planStore";
import { retryResult } from "../../../src/utils/retry";
import {
  configureSandbox,
  describeSandbox,
  resolveInSandbox,
} from "../../../src/utils/sandbox";
import { formatTaskList, loadTasks } from "../../../src/utils/taskStore";
import { toolsCache } from "../../../src/utils/toolsCache";
import { appendTranscriptEntry } from "../../../src/utils/transcriptStore";
import { CLI_VERSION, UPSTREAM_CLI_VERSION } from "../../../src/utils/version";
import { getWorkspaceModels } from "../../../src/utils/workspaceModels";
import type {
  AgentInfo,
  ApprovalDecision,
  ApprovalRequest,
  AttachmentInfo,
  ChatMode,
  ConversationSummary,
  Effort,
  ModelList,
  ModelRow,
  NotifySettings,
  PanelLayout,
  PlanChoice,
  Result,
  SessionBadge,
  SessionEvent,
  SessionState,
  SessionStatus,
  SkillRow,
  TaskItem,
  TranscriptItem,
  Usage,
} from "../shared/ipc";
import { applyTranscriptEvent } from "../shared/transcript";
import { sessionExpired } from "./auth";
import { DEFAULT_NOTIFY, mergeNotify, notifySession, setAttention, setNotifyActivate } from "./notify";
import type { NotifyKind } from "./notify";
import { deleteConversationPrivate, fetchHistoryPage } from "./history";
import { emit } from "./bus";
import { loadSettings, updateSettings } from "./settings";
import {
  buildDiff,
  describeToolCall,
  itemsFromConversation,
  newId,
} from "./transcript";

/**
 * The desktop app's conversation engine. The loop is the one in
 * src/ui/commands/chat/nonInteractive.ts and Chat.tsx (create or post a
 * message, stream the answer, answer tool approvals), minus the terminal UI.
 *
 * SEVERAL CONVERSATIONS RUN AT ONCE. Everything that belongs to one
 * conversation lives on a `Session` (stream, queue, mode, approvals, tasks,
 * loop, attachments, skills/priming state, transcript...). The module-level
 * state below is only what is genuinely app-wide: identity, agents, the
 * working folder (the sandbox root and process.cwd() are process-global, so
 * every session shares one folder), the concurrency cap and the registry.
 * The window views exactly one session (`selected`); switching re-sends that
 * session's transcript and state in one `view` event. Background sessions keep
 * streaming into their own `items` and send nothing to the renderer except a
 * lightweight badge list.
 *
 * Per-call tool state (plan mode, the conversation id todo_write persists
 * against, whether Claude skills are on) is NOT read from the module-level
 * singletons in planMode.ts / taskStore.ts / skillStore.ts any more: with
 * parallel turns one global value would be wrong. Each session registers its
 * own fs MCP server, and Dust routes a tool call to the server ids listed in
 * that message's `clientSideMCPServerIds`, so the server a call arrives on
 * identifies its conversation by construction. That server's tools are built
 * with a `ToolContext` bound to the session (src/mcp/toolContext.ts). The
 * singletons are never written from here and stay at their CLI defaults.
 *
 * The call sites that must stay wired:
 *   - configureSandbox + chdir:  setFolder()   (every folder change; global)
 *   - the fs MCP servers:        ensureFsServer(s) / closeFsServer(s) (closed on
 *                                dispose, sign-out and before a new sign-in)
 *   - per-session context:       makeToolContext(s) (used by BOTH the real
 *                                server and the smoke-test tool set)
 * Missing one of them is a known bug class in this repo.
 */

type AgentConfiguration =
  GetAgentConfigurationsResponseType["agentConfigurations"][number];
type Conversation = CreateConversationResponseType["conversation"];

// ------------------------------------------------------------------ types

// An uploaded file waiting to go out with a message.
interface UploadedFile {
  id: string;
  fileId: string;
  name: string;
  size: number;
  contentType: string;
  isImage: boolean;
}
interface QueuedMessage {
  id: string;
  text: string;
  files: UploadedFile[];
  // A /loop tick. Never deduplicated, and a pending one makes the next tick
  // skip rather than stack (loopController.ts).
  loop?: boolean;
}

/** What survives a session being retired while its conversation is idle. */
interface Prefs {
  mode: ChatMode;
  modelOverride: (ModelChoice & { label: string }) | null;
  effort: Effort | null;
  claudeCodeMode: boolean;
  claudeContext: ClaudeContext | null;
  agentId: string | null;
}

interface Session {
  key: string;
  conversationId: string | null;
  conversationTitle: string | null;
  agentId: string | null;
  mode: ChatMode;
  modelOverride: (ModelChoice & { label: string }) | null;
  effort: Effort | null;
  busy: boolean;
  thinking: boolean;
  actionLabel: string | null;
  queue: QueuedMessage[];
  // Attachments shown in the composer (uploading or ready) for the next send.
  attachments: (AttachmentInfo & { fileId?: string })[];
  pendingAgent: { name: string; detail: string | null } | null;
  compacting: string | null;
  btwStatus: string | null;
  // Cursor for "Load earlier messages" (see history.ts); null = nothing older.
  earlierCursor: number | null;
  loadingEarlier: boolean;
  loop: LoopState | null;
  loopTimer: ReturnType<typeof setInterval> | null;
  // /claude-code-mode and /skills state. These mirror the refs Chat.tsx keeps;
  // see the comments on the originals for why each exists.
  claudeCodeMode: boolean;
  claudeContext: ClaudeContext | null;
  pendingClaudePriming: boolean;
  pendingForcedSkills: Skill[];
  lastSentSkillCatalogue: string | null;
  skillRevision: number;
  tasks: TaskItem[];
  context: Usage["context"];
  notice: string | null;
  // The transcript, kept in main for every session so a background one has
  // something to show when it is opened.
  items: TranscriptItem[];
  // Bumped when this session is retired or torn down. Work that started before
  // (a turn, an upload, a compaction, a usage refresh) compares its captured
  // value before writing, so a late result is dropped.
  epoch: number;
  disposed: boolean;
  // Per-turn handles.
  controller: AbortController | null;
  activeClient: DustAPI | null;
  activeAgentMessageId: string | null;
  currentToolName: string;
  // What the agent has said so far this turn (primes /btw mid-turn).
  inFlightText: string;
  cancelFallback: ReturnType<typeof setTimeout> | null;
  approvals: Map<
    string,
    { request: ApprovalRequest; resolve: (d: ApprovalDecision) => void }
  >;
  planPending: {
    id: string;
    markdown: string;
    resolve: (d: PlanDecision) => void;
  } | null;
  lastAccepted: { text: string; at: number } | null;
  // Uploads run one at a time per session: the first may have to create the
  // (empty) conversation the files belong to, as the CLI does, and two uploads
  // racing would create two.
  uploadChain: Promise<void>;
  // The conversation the first upload had to create (as the CLI does: an
  // upload needs a conversation id), until a message is posted into it. Until
  // then it is empty, and it is deleted rather than left behind in the user's
  // history if every upload fails, the chips are all removed, or the user moves
  // on.
  filesOnlyConversationId: string | null;
  // This session's own fs MCP server (see the header comment).
  fsServerId: string | null;
  /** The server id the running turn was sent with (its tool calls are routed there). */
  turnFsServerId: string | null;
  fsPromise: Promise<void> | null;
  fsGeneration: number;
  fsClose: (() => Promise<void>) | null;
  // A message is waiting for a free slot under the concurrency cap.
  slotWait: boolean;
  // Finished or failed while another session was on screen; cleared on view.
  unread: boolean;
  errored: boolean;
  // Smoke-test seam: this session's tool set, without a transport.
  testTools: ReturnType<typeof buildFsTools> | null;
  // The user asked to stop the running turn (so the note can say so).
  stopRequested: boolean;
}

// ------------------------------------------------------------------ app state

let me: MeResponseType["user"] | null = null;
let workspaceName: string | null = null;
let agents: AgentConfiguration[] = [];
// The agent new conversations start with (the last one picked, remembered).
let defaultAgentId: string | null = null;
let folder: string | null = null;
let branch: string | null = null;
let globalNotice: string | null = null;
let creditsUsage: Usage["credits"] = null;
// Bumped on sign-out / identity change so a late credits fetch is dropped.
let identityEpoch = 0;
let initPromise: Promise<void> | null = null;
const knownTitles = new Map<string, string>();

const DEFAULT_MAX_PARALLEL = 3;
const MAX_PARALLEL_LIMIT = 8;
let maxParallel = DEFAULT_MAX_PARALLEL;

const sessions = new Map<string, Session>();
let selected: Session | null = null;
// Sessions with a message waiting for a free slot, oldest first.
let slotWaiters: Session[] = [];
// Preferences of retired idle sessions, by conversation id, so reopening a
// conversation keeps its mode/model for as long as the app runs.
const prefsByConversation = new Map<string, Prefs>();
let sessionCounter = 0;

const DEFAULT_LAYOUT: PanelLayout = { left: 280, right: 290, leftCollapsed: false, rightCollapsed: false };
const LAYOUT_LIMITS = { left: [200, 480], right: [220, 480] } as const;
let panelLayout: PanelLayout = { ...DEFAULT_LAYOUT };
let notifyCfg: NotifySettings = { ...DEFAULT_NOTIFY };

// A clicked toast selects its conversation.
setNotifyActivate((key) => {
  selectSession(key);
});

function clampWidth(v: unknown, side: "left" | "right"): number {
  const [lo, hi] = LAYOUT_LIMITS[side];
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : DEFAULT_LAYOUT[side];
}

export function setLayout(patch: Record<string, unknown>): Result {
  panelLayout = {
    left: "left" in patch ? clampWidth(patch.left, "left") : panelLayout.left,
    right: "right" in patch ? clampWidth(patch.right, "right") : panelLayout.right,
    leftCollapsed: typeof patch.leftCollapsed === "boolean" ? patch.leftCollapsed : panelLayout.leftCollapsed,
    rightCollapsed: typeof patch.rightCollapsed === "boolean" ? patch.rightCollapsed : panelLayout.rightCollapsed,
  };
  void updateSettings({ layout: panelLayout });
  return { ok: true };
}

export function setNotify(patch: Record<string, unknown>): Result {
  notifyCfg = mergeNotify(notifyCfg, patch);
  void updateSettings({ notify: notifyCfg });
  emitState();
  return { ok: true };
}

export function getNotifySettings(): NotifySettings {
  return notifyCfg;
}

/** Toast for `s` (policy and wording are in notify.ts). */
function toast(s: Session, kind: NotifyKind, summary: string): void {
  if (s.disposed || testClient === null && !me) return;
  notifySession(
    {
      kind,
      key: s.key,
      agentName: agentOf(s)?.name ?? "dust",
      conversationTitle: s.conversationTitle ?? "New chat",
      summary,
      selected: s === selected,
    },
    notifyCfg
  );
}

function refreshAttention(): void {
  let count = 0;
  let needs = 0;
  for (const s of sessions.values()) {
    const st = statusOf(s);
    if (st === "approval") { count++; needs++; }
    else if ((st === "finished" || st === "error") && s !== selected) count++;
  }
  setAttention(count, needs);
}
// The conversation being opened from history, if any. Window-level: while it
// is set the centre shows "Opening...". A newer switch supersedes it.
let loadingConversationId: string | null = null;
let loadSeq = 0;

// Smoke-test seam (see smoke.ts): a stand-in for the Dust client so the
// duplicate-send test can run turns without spending credits.
let testClient: DustAPI | null = null;
export function setTestClient(client: unknown): void {
  testClient = client as DustAPI | null;
}
async function currentClient(): Promise<DustAPI | null> {
  if (testClient) {
    return testClient;
  }
  const res = await getDustClient();
  return res.isOk() ? res.value : null;
}

// ------------------------------------------------------------------ sessions

function createSession(from?: Session | null, prefs?: Prefs | null): Session {
  const s: Session = {
    key: `s${++sessionCounter}`,
    conversationId: null,
    conversationTitle: null,
    agentId: prefs?.agentId ?? defaultAgentId,
    // A session starts in normal mode: auto must never leak into a new
    // conversation, and plan is something the user turns on per conversation.
    mode: prefs?.mode ?? "normal",
    // Model and effort are sticky preferences, copied (not shared).
    modelOverride: prefs ? prefs.modelOverride : from?.modelOverride ?? null,
    effort: prefs ? prefs.effort : from?.effort ?? null,
    busy: false,
    thinking: false,
    actionLabel: null,
    queue: [],
    attachments: [],
    pendingAgent: null,
    compacting: null,
    btwStatus: null,
    earlierCursor: null,
    loadingEarlier: false,
    loop: null,
    loopTimer: null,
    claudeCodeMode: false,
    claudeContext: null,
    pendingClaudePriming: false,
    pendingForcedSkills: [],
    lastSentSkillCatalogue: null,
    skillRevision: 0,
    tasks: [],
    context: null,
    notice: null,
    items: [],
    epoch: 0,
    disposed: false,
    controller: null,
    activeClient: null,
    activeAgentMessageId: null,
    currentToolName: "tool",
    inFlightText: "",
    cancelFallback: null,
    approvals: new Map(),
    planPending: null,
    lastAccepted: null,
    uploadChain: Promise.resolve(),
    filesOnlyConversationId: null,
    fsServerId: null,
    turnFsServerId: null,
    fsPromise: null,
    fsGeneration: 0,
    fsClose: null,
    slotWait: false,
    unread: false,
    errored: false,
    testTools: null,
    stopRequested: false,
  };
  const claudeSource = prefs ?? from;
  if (claudeSource?.claudeCodeMode && claudeSource.claudeContext) {
    s.claudeCodeMode = true;
    s.claudeContext = claudeSource.claudeContext;
    // A new conversation has not been primed yet.
    s.pendingClaudePriming = true;
  }
  sessions.set(s.key, s);
  return s;
}

/** The session on screen. Created lazily so getState() is always answerable. */
function current(): Session {
  if (!selected) {
    selected = createSession(null);
  }
  return selected;
}

function findByConversation(id: string): Session | null {
  for (const s of sessions.values()) {
    if (s.conversationId === id) {
      return s;
    }
  }
  return null;
}

function runningCount(): number {
  let n = 0;
  for (const s of sessions.values()) {
    if (s.busy) n++;
  }
  return n;
}

function anyBusy(): boolean {
  for (const s of sessions.values()) {
    if (s.busy || s.compacting) return true;
  }
  return false;
}

function statusOf(s: Session): SessionStatus {
  if (s.approvals.size > 0 || s.planPending) return "approval";
  if (s.busy || s.compacting) return "running";
  if (s.slotWait) return "waiting-slot";
  if (s.errored) return "error";
  if (s.unread) return "finished";
  return "idle";
}

function badgesOf(): SessionBadge[] {
  return [...sessions.values()].map((s) => ({
    key: s.key,
    conversationId: s.conversationId,
    title:
      s.conversationTitle ??
      (s.conversationId ? knownTitles.get(s.conversationId) : undefined) ??
      "New chat",
    status: statusOf(s),
    selected: s === selected,
  }));
}

/**
 * Nothing running, queued, pending or unseen: safe to drop from memory. Unsent
 * attachments do not keep a session alive: leaving a conversation discards
 * them, as it always did (a conversation an upload created is deleted again).
 */
function isQuiescent(s: Session): boolean {
  return (
    !s.busy &&
    !s.compacting &&
    !s.slotWait &&
    s.approvals.size === 0 &&
    !s.planPending &&
    !s.loop &&
    s.queue.length === 0 &&
    !s.unread &&
    !s.errored &&
    s.btwStatus === null &&
    !s.loadingEarlier
  );
}

/** Makes `next` the session on screen and sends the window its whole view. */
function select(next: Session): void {
  const prev = selected;
  selected = next;
  next.unread = false;
  next.errored = false;
  emitView();
  if (prev && prev !== next && !prev.disposed && isQuiescent(prev)) {
    disposeSession(prev);
  }
  // The usage numbers of a session that ran in the background are stale.
  void refreshUsage(next);
}

function emitView(): void {
  const s = current();
  const first = s.approvals.values().next().value;
  emit({
    type: "view",
    sid: s.key,
    items: s.items,
    state: getState(),
    approval: first ? { request: first.request, pending: s.approvals.size } : null,
    planId: s.planPending?.id ?? null,
  });
}

/** Drops an idle session, keeping what is worth remembering for a reopen. */
function disposeSession(s: Session): void {
  if (s.disposed) {
    return;
  }
  if (s.conversationId) {
    prefsByConversation.set(s.conversationId, {
      mode: s.mode,
      modelOverride: s.modelOverride,
      effort: s.effort,
      claudeCodeMode: s.claudeCodeMode,
      claudeContext: s.claudeContext,
      agentId: s.agentId,
    });
  }
  stopLoopOf(s, "closed", { quiet: true });
  rejectAllPending(s);
  discardFilesOnlyConversation(s);
  s.attachments = [];
  closeFsServer(s);
  s.disposed = true;
  s.epoch++;
  sessions.delete(s.key);
  slotWaiters = slotWaiters.filter((w) => w !== s);
}

// ------------------------------------------------------------------ state out

export function getState(): SessionState {
  return buildState(current());
}

/** The state of any live session (the smoke tests read background ones). */
export function getSessionState(key: string): SessionState | null {
  const s = sessions.get(key);
  return s ? buildState(s) : null;
}

export function getSelectedKey(): string {
  return current().key;
}

export function listSessionKeys(): string[] {
  return [...sessions.keys()];
}

function buildState(s: Session): SessionState {
  return {
    version: CLI_VERSION,
    upstreamVersion: UPSTREAM_CLI_VERSION,
    workspaceName,
    userName: me?.fullName ?? null,
    agents: agents.map(toAgentInfo),
    agentId: s.agentId,
    folder,
    branch,
    mode: s.mode,
    modelOverride: s.modelOverride
      ? { modelId: s.modelOverride.modelId, label: s.modelOverride.label }
      : null,
    effort: s.effort,
    conversationId: s.conversationId,
    conversationTitle: s.conversationTitle,
    busy: s.busy,
    thinking: s.thinking,
    actionLabel: s.actionLabel,
    queue: s.queue.map((q) => ({ id: q.id, text: q.text })),
    pendingAgent: s.pendingAgent,
    loadingConversationId,
    compacting: s.compacting,
    btwStatus: s.btwStatus,
    loop: s.loop
      ? {
          intervalMs: s.loop.intervalMs,
          prompt: s.loop.prompt,
          runs: s.loop.runs,
          maxRuns: s.loop.maxRuns,
          skipped: s.loop.skipped,
          summary: describeLoop(s.loop),
        }
      : null,
    claudeCodeMode: s.claudeCodeMode,
    forcedSkills: s.pendingForcedSkills.map((k) => k.name),
    attachments: s.attachments.map(({ fileId: _f, ...a }) => a),
    hasEarlier: s.earlierCursor !== null,
    loadingEarlier: s.loadingEarlier,
    tasks: s.tasks,
    usage: { context: s.context, credits: creditsUsage },
    sandbox: describeSandbox(),
    notice: s.notice ?? globalNotice,
    sessionKey: s.key,
    sessions: badgesOf(),
    running: runningCount(),
    maxParallel,
    waitingForSlot: s.slotWait,
    layout: panelLayout,
    notify: notifyCfg,
  };
}

/** Pushes the selected session's state to the window. */
function emitState(): void {
  refreshAttention();
  emit({ type: "state", state: getState(), sid: current().key });
}

function emitSessions(): void {
  refreshAttention();
  emit({ type: "sessions", sessions: badgesOf(), running: runningCount() });
}

/**
 * Something about `s` changed. The window gets the whole state when `s` is the
 * one on screen, and only the badge list otherwise: a background session that
 * streams and runs tools must not cost the renderer a full state per event.
 */
function stateChanged(s: Session): void {
  if (s.disposed) {
    return;
  }
  if (s === selected) {
    emitState();
  } else {
    emitSessions();
  }
}

function toAgentInfo(a: AgentConfiguration): AgentInfo {
  return {
    sId: a.sId,
    name: a.name,
    description: a.description,
    model: a.model
      ? { modelId: a.model.modelId, providerId: a.model.providerId }
      : null,
  };
}

function agentOf(s: Session): AgentConfiguration | null {
  return agents.find((a) => a.sId === s.agentId) ?? null;
}

/**
 * Every transcript change goes through here: it is applied to the session's own
 * list (always) and sent to the window only if the session is on screen.
 */
function tx(
  s: Session,
  event: Extract<
    SessionEvent,
    | { type: "append" }
    | { type: "text-delta" }
    | { type: "patch" }
    | { type: "transcript-reset" }
    | { type: "transcript-prepend" }
  >
): void {
  s.items = applyTranscriptEvent(s.items, event);
  if (s === selected && !s.disposed) {
    emit({ ...event, sid: s.key });
  }
}

function appendItem(s: Session, item: TranscriptItem): void {
  tx(s, { type: "append", item });
}

function note(s: Session, tone: "info" | "error", text: string): void {
  appendItem(s, { kind: "note", id: newId(), tone, text });
}

// ------------------------------------------------------------------ init

/** Idempotent: loads user, agents, remembered folder and agent. */
export function initSession(): Promise<void> {
  if (!initPromise) {
    initPromise = doInit().catch((error) => {
      initPromise = null;
      globalNotice = normalizeError(error).message;
      emitState();
    });
  }
  return initPromise;
}

function teardownOne(s: Session): { client: DustAPI | null; convId: string | null; messageId: string | null } {
  const out = {
    client: s.busy ? s.activeClient : null,
    convId: s.conversationId,
    messageId: s.activeAgentMessageId,
  };
  s.epoch++;
  s.disposed = true;
  stopLoopOf(s, "signed out", { quiet: true });
  s.queue = [];
  rejectAllPending(s);
  s.controller?.abort();
  if (s.cancelFallback) {
    clearTimeout(s.cancelFallback);
    s.cancelFallback = null;
  }
  discardFilesOnlyConversation(s);
  s.attachments = [];
  closeFsServer(s);
  return out;
}

/**
 * Stops everything tied to the current identity, for EVERY session: each loop,
 * each running turn (cancelled server-side too, while the token still works),
 * pending dialogs, queued messages and attachments, each session's fs MCP
 * server. Called before a sign-out clears the tokens, when a session is found
 * expired, and before a fresh sign-in starts a new session.
 */
export async function teardownSession(): Promise<void> {
  // Everything synchronous first, so a new session started right after this
  // call (resetSession -> initSession) can never be undone by our tail.
  identityEpoch++;
  const cancels = [...sessions.values()].map(teardownOne);
  sessions.clear();
  slotWaiters = [];
  prefsByConversation.clear();
  loadSeq++;
  loadingConversationId = null;
  creditsUsage = null;
  // A fresh, empty session takes the place of the old ones, in normal mode.
  selected = null;
  const fresh = current();
  emit({ type: "view", sid: fresh.key, items: [], state: getState(), approval: null, planId: null });
  // Aborting the local stream alone would leave the agent running (and
  // spending credits) server-side; this has to happen before the tokens go.
  await Promise.all(
    cancels.map(async ({ client, convId, messageId }) => {
      if (client && convId && messageId) {
        await client
          .cancelMessageGeneration({ conversationId: convId, messageIds: [messageId] })
          .catch(() => undefined);
      }
    })
  );
}

/** Forget everything tied to the previous sign-in. */
export function resetSession(): void {
  void teardownSession();
  initPromise = null;
  me = null;
  agents = [];
  defaultAgentId = null;
  for (const s of sessions.values()) {
    s.agentId = null;
  }
  workspaceName = null;
  globalNotice = null;
  knownTitles.clear();
  emit({ type: "transcript-reset", items: [] });
}

async function doInit(): Promise<void> {
  const clientRes = await getDustClient();
  if (clientRes.isErr()) {
    throw clientRes.error;
  }
  const dust = clientRes.value;
  if (!dust) {
    await sessionExpired("Your session is no longer valid.");
    throw new Error("Not signed in.");
  }

  const token = await AuthService.getValidAccessToken();
  const isApiKey = token.isOk() && token.value?.startsWith("sk-");
  const workspaceId = await AuthService.getSelectedWorkspaceId();

  if (isApiKey) {
    // Same placeholder the CLI's useMe hook builds: API keys can't call me().
    me = {
      sId: "api-user",
      id: 0,
      createdAt: Date.now(),
      provider: "google",
      username: "api-user",
      email: "api-user@workspace",
      firstName: "API",
      lastName: "User",
      fullName: "API User",
      image: null,
      workspaces: [],
    };
  } else {
    const meRes = await retryResult(() => dust.me());
    if (meRes.isErr()) {
      throw new Error(`Failed to get user information: ${meRes.error.message}`);
    }
    me = meRes.value;
    workspaceName =
      me.workspaces?.find((w) => w.sId === workspaceId)?.name ?? null;
  }

  if (!workspaceId) {
    throw new Error("No workspace selected.");
  }
  await loadAgents(dust, workspaceId);

  const settings = await loadSettings();
  const remembered = agents.find((a) => a.sId === settings.agentId);
  const dustAgent = agents.find((a) => a.sId === "dust");
  defaultAgentId = (remembered ?? dustAgent ?? agents[0])?.sId ?? null;
  if (
    typeof settings.maxParallel === "number" &&
    Number.isInteger(settings.maxParallel) &&
    settings.maxParallel >= 1 &&
    settings.maxParallel <= MAX_PARALLEL_LIMIT
  ) {
    maxParallel = settings.maxParallel;
  }
  panelLayout = {
    left: clampWidth(settings.layout?.left, "left"),
    right: clampWidth(settings.layout?.right, "right"),
    leftCollapsed: settings.layout?.leftCollapsed === true,
    rightCollapsed: settings.layout?.rightCollapsed === true,
  };
  notifyCfg = mergeNotify(DEFAULT_NOTIFY, settings.notify);
  // The session on screen (an empty one) takes the remembered agent.
  for (const s of sessions.values()) {
    if (!s.agentId) {
      s.agentId = defaultAgentId;
    }
  }
  current();

  if (settings.workingDir && isDirectory(settings.workingDir)) {
    setFolder(settings.workingDir, false);
  }
  void refreshUsage(current());
  emitState();
}

async function loadAgents(dust: DustAPI, workspaceId: string): Promise<void> {
  const cached = await agentCache.get(workspaceId);
  const fetchFresh = async () => {
    const res = await retryResult(() => dust.getAgentConfigurations({}));
    if (res.isErr()) {
      throw new Error(`API Error fetching agents: ${res.error.message}`);
    }
    agents = sortAgents(res.value);
    await agentCache.set(workspaceId, res.value).catch(() => undefined);
  };
  if (cached) {
    agents = sortAgents(cached);
    void fetchFresh()
      .then(emitState)
      .catch(() => undefined);
    return;
  }
  await fetchFresh();
}

function sortAgents(list: AgentConfiguration[]): AgentConfiguration[] {
  return [...list].sort((a, b) => {
    if (a.sId === "dust") return -1;
    if (b.sId === "dust") return 1;
    return a.name.localeCompare(b.name);
  });
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ settings

export function getMaxParallel(): number {
  return maxParallel;
}

/** The cap on concurrently running turns. Raising it releases waiting sends. */
export function setMaxParallel(n: number, persist = true): Result {
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARALLEL_LIMIT) {
    return { ok: false, error: `Choose a number from 1 to ${MAX_PARALLEL_LIMIT}.` };
  }
  maxParallel = n;
  if (persist) {
    void updateSettings({ maxParallel: n });
  }
  pumpSlots();
  emitState();
  return { ok: true };
}

// ------------------------------------------------------------------ folder

// The working folder is app-global for now: the sandbox root and process.cwd()
// are process-wide, so every session shares it. A folder per session would
// need those two made per call first (see AGENTS.md).
export function setFolder(dir: string, persist = true): Result {
  if (anyBusy()) {
    return { ok: false, error: "Stop the running turns before changing folder." };
  }
  if (!isDirectory(dir)) {
    return { ok: false, error: "That folder does not exist." };
  }
  // The sandbox root is the chosen folder, not whatever cwd the app started
  // in. chdir as well: several tools default to process.cwd() (run_command,
  // search_files, search_content, memory lookups).
  configureSandbox({ root: dir });
  process.chdir(dir);
  folder = dir;
  branch = getGitBranch(dir);
  if (persist) {
    void updateSettings({ workingDir: dir });
  }
  void seedToolCache();
  void ensureFsServer(current());
  emitState();
  return { ok: true };
}

// edit_file goes through the diff dialog, so Dust's own generic approval for
// it would be a second, redundant prompt. The CLI pre-caches the same entry.
async function seedToolCache(): Promise<void> {
  const key = { mcpServerName: "fs-cli", toolName: "edit_file" };
  if ((await toolsCache.getCachedApproval(key)) === null) {
    await toolsCache.setCachedApproval(key);
  }
}

// ------------------------------------------------------------------ fs server

/**
 * What a session's tools ask instead of the module-level singletons. This is
 * the whole per-call mechanism: the tools of session A are built with A's
 * context, the tools of session B with B's, so A being in plan mode cannot
 * affect a call made on B's server.
 */
function makeToolContext(s: Session): ToolContext {
  return {
    // Fails closed: a call that reaches a retired or torn-down session's
    // server (its transport closes asynchronously) is refused like a write in
    // plan mode, never run under stale or default permissions.
    isPlanMode: () => s.disposed || s.mode === "plan",
    getConversationId: () => s.conversationId,
    areClaudeSkillsEnabled: () => s.claudeCodeMode,
    onTasksUpdated: (todos) => {
      s.tasks = todos;
      stateChanged(s);
    },
  };
}

function closeFsServer(s: Session): void {
  s.fsGeneration++;
  const close = s.fsClose;
  s.fsClose = null;
  s.fsServerId = null;
  s.fsPromise = null;
  if (close) {
    void close().catch(() => undefined);
  }
}

// Smoke-test seam: lets the harness observe that a sign-out closes the server.
// Applies to the session on screen. Returns the real handle it displaced,
// which the harness must put back: dropping it leaves the real transport
// running untracked and makes the next ensureFsServer() register a second one.
export function setFsServerForTest(
  id: string | null,
  close: (() => Promise<void>) | null
): { id: string | null; close: (() => Promise<void>) | null } {
  const s = current();
  const previous = { id: s.fsServerId, close: s.fsClose };
  s.fsServerId = id;
  s.fsClose = close;
  return previous;
}

/**
 * Smoke-test seam: the tools a session's server would serve, built with that
 * session's real callbacks and context but no transport. Calling `write_file`
 * on one session's set and on another's is how the isolation test proves a
 * mode never leaks.
 */
export function sessionToolsForTest(key: string): Record<string, { execute: (args: never) => Promise<unknown> }> {
  const s = sessions.get(key);
  if (!s) {
    throw new Error(`No session ${key}.`);
  }
  s.testTools ??= buildSessionTools(s);
  return Object.fromEntries(s.testTools.map((t) => [t.name, t])) as never;
}

function buildSessionTools(s: Session): ReturnType<typeof buildFsTools> {
  return buildFsTools({
    diffApprovalCallback: (original, updated, filePath) =>
      requestDiffApproval(s, original, updated, filePath),
    planApprovalCallback: (plan) => requestPlanApproval(s, plan),
    toolContext: makeToolContext(s),
  });
}

// Each session registers its own server against the one identity (the DustAPI
// client and workspace it captured). It does NOT need re-registering on a
// folder switch: every tool resolves paths at call time through the sandbox
// singleton and process.cwd(), both of which setFolder() updates. It DOES on a
// sign-out or a new sign-in: the old transport would otherwise keep polling for
// tool calls under the old identity. `fsGeneration` makes a registration that
// completes after it was superseded close itself instead of becoming current.
function ensureFsServer(s: Session): Promise<void> {
  if (s.fsServerId || testClient || s.disposed) {
    return Promise.resolve();
  }
  if (!s.fsPromise) {
    const generation = s.fsGeneration;
    const isCurrent = () => generation === s.fsGeneration;
    const attempt = (async () => {
      const clientRes = await getDustClient();
      const dust = clientRes.isOk() ? clientRes.value : null;
      if (!dust || !isCurrent()) {
        if (isCurrent()) s.fsPromise = null;
        return;
      }
      const res = await useFileSystemServer(
        dust,
        (serverId) => {
          // A heartbeat re-registration of a superseded server must not
          // overwrite the current id.
          if (isCurrent()) {
            s.fsServerId = serverId;
            // A re-registration mid-turn gives a new id, and Dust keeps
            // routing this turn's tool calls to the old one: they would go
            // unanswered until Dust times out. Say so instead of hanging.
            if (s.busy && s.turnFsServerId && s.turnFsServerId !== serverId) {
              s.turnFsServerId = null;
              note(
                s,
                "error",
                "The local file tools reconnected during this turn, so its remaining tool calls cannot be answered. Stop (Esc Esc) and resend; the next message uses the new connection."
              );
            }
          }
        },
        (original, updated, filePath) =>
          requestDiffApproval(s, original, updated, filePath),
        undefined,
        (plan) => requestPlanApproval(s, plan),
        (close) => {
          if (isCurrent()) {
            s.fsClose = close;
          } else {
            void close().catch(() => undefined);
          }
        },
        makeToolContext(s)
      );
      if (res.isErr() && isCurrent()) {
        s.notice = res.error.message;
        s.fsPromise = null;
        stateChanged(s);
      }
    })();
    s.fsPromise = attempt;
  }
  return s.fsPromise;
}

// ------------------------------------------------------------------ mode

function applyMode(s: Session, next: ChatMode): void {
  if (s.mode === next) {
    return;
  }
  // The single point where UI state becomes tool behaviour: the session's own
  // tool context reads `s.mode` at call time. No module-level singleton is
  // written (see the header comment).
  s.mode = next;
  stateChanged(s);
}

export function setMode(next: ChatMode): Result {
  applyMode(current(), next);
  return { ok: true };
}

export function cycleMode(): Result {
  const s = current();
  applyMode(s, nextChatMode(s.mode as CliChatMode) as ChatMode);
  return { ok: true };
}

// ------------------------------------------------------------------ approvals

function publishApprovals(s: Session): void {
  if (s === selected && !s.disposed) {
    const first = s.approvals.values().next().value;
    emit({
      type: "approval",
      request: first ? first.request : null,
      pending: s.approvals.size,
      sid: s.key,
    });
  }
  // The badge (yellow dot) changes with it.
  stateChanged(s);
}

// A background session's approval never pops over the view: it waits on its
// own session, the sidebar shows a dot, and opening the session shows it (the
// `view` event carries the first pending approval).
function ask(s: Session, request: ApprovalRequest): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    s.approvals.set(request.id, { request, resolve });
    publishApprovals(s);
    toast(s, "approval", request.tool);
  });
}

export function resolveApproval(id: string, decision: ApprovalDecision): Result {
  for (const s of sessions.values()) {
    const entry = s.approvals.get(id);
    if (entry) {
      s.approvals.delete(id);
      entry.resolve(decision);
      publishApprovals(s);
      return { ok: true };
    }
  }
  return { ok: false, error: "That approval is no longer pending." };
}

function rejectAllPending(s: Session): void {
  const had = s.approvals.size > 0;
  for (const [id, entry] of s.approvals) {
    s.approvals.delete(id);
    entry.resolve({ kind: "reject" });
  }
  if (had) {
    publishApprovals(s);
  }
  if (s.planPending) {
    const pending = s.planPending;
    s.planPending = null;
    pending.resolve({ kind: "reject" });
    // The card in the transcript must not stay "pending" with no way to act.
    tx(s, { type: "patch", id: pending.id, patch: { outcome: "rejected" } as never });
    if (s === selected && !s.disposed) {
      emit({ type: "plan-clear", sid: s.key });
    }
    stateChanged(s);
  }
}

async function requestDiffApproval(
  s: Session,
  original: string,
  updated: string,
  filePath: string
): Promise<boolean> {
  // A tool call that arrives with no turn running (a stale action from a
  // cancelled or torn-down turn) has nobody to approve it: refuse it. A
  // torn-down session can still be `busy` until its stream unwinds.
  if (!s.busy || s.disposed) {
    return false;
  }
  const diff = buildDiff(filePath, original, updated);
  const tool = s.currentToolName;

  if (s.mode === "auto") {
    appendItem(s, { kind: "diff", id: newId(), tool, diff });
    return true;
  }

  const decision = await ask(s, {
    id: newId(),
    type: "edit",
    tool,
    diff,
    insideSandbox: resolveInSandbox(filePath).isOk(),
    sandbox: describeSandbox(),
  });

  if (decision.kind === "reject") {
    // The tool only learns "rejected". A note is delivered to the agent as
    // the next message instead, so the reason isn't lost.
    const text = decision.note?.trim();
    if (text) {
      s.queue.unshift({
        id: newId(),
        text: `About the edit to ${filePath} that I just rejected: ${text}`,
        files: [],
      });
      stateChanged(s);
    }
    return false;
  }
  if (decision.kind === "approve-all") {
    applyMode(s, "auto");
  }
  appendItem(s, { kind: "diff", id: newId(), tool, diff });
  return true;
}

async function requestPlanApproval(s: Session, plan: string): Promise<PlanDecision> {
  if (!s.busy || s.disposed) {
    return { kind: "reject" };
  }
  // A second present_plan while one is pending replaces it; the first
  // caller must not be left waiting forever.
  if (s.planPending) {
    const previous = s.planPending;
    s.planPending = null;
    tx(s, { type: "patch", id: previous.id, patch: { outcome: "rejected" } as never });
    previous.resolve({ kind: "reject" });
  }
  const id = newId();
  appendItem(s, { kind: "plan", id, markdown: plan, outcome: "pending" });
  if (s === selected) {
    emit({ type: "plan-request", id, markdown: plan, sid: s.key });
  }
  return new Promise<PlanDecision>((resolve) => {
    s.planPending = { id, markdown: plan, resolve };
    stateChanged(s);
    toast(s, "approval", "plan review");
  });
}

export async function resolvePlan(id: string, choice: PlanChoice): Promise<Result> {
  let s: Session | null = null;
  for (const candidate of sessions.values()) {
    if (candidate.planPending?.id === id) {
      s = candidate;
    }
  }
  if (!s || !s.planPending) {
    return { ok: false, error: "That plan is no longer pending." };
  }
  const pending = s.planPending;
  s.planPending = null;

  const decision: PlanDecision =
    choice.kind === "approve"
      ? { kind: "approve", then: choice.then }
      : { kind: "reject", comment: choice.comment?.trim() || undefined };

  if (decision.kind === "approve") {
    // Leaving plan mode is the user's approval, here and nowhere else: the
    // agent cannot lift the restriction by calling present_plan itself.
    applyMode(s, decision.then === "auto" ? "auto" : "normal");
    await saveApprovedPlan(s.conversationId, pending.markdown);
  }
  tx(s, {
    type: "patch",
    id,
    patch: {
      outcome:
        decision.kind === "approve"
          ? decision.then === "auto"
            ? "approved-auto"
            : "approved-wait"
          : "rejected",
      comment: decision.kind === "reject" ? decision.comment : undefined,
    } as never,
  });
  if (s === selected) {
    emit({ type: "plan-clear", sid: s.key });
  }
  pending.resolve(decision);
  stateChanged(s);
  return { ok: true };
}

/** Dust's own tool-approval step (distinct from the diff dialog). */
async function handleToolApproval(
  s: Session,
  event: AgentActionSpecificEvent
): Promise<boolean> {
  if (event.type !== "tool_approve_execution") {
    return false;
  }
  // In plan mode a blocked tool must reach the tool itself, whose refusal
  // explains plan mode and points at present_plan (see Chat.tsx).
  if (
    s.mode === "plan" &&
    (PLAN_MODE_BLOCKED_TOOLS as readonly string[]).includes(
      event.metadata.toolName
    )
  ) {
    return true;
  }
  // Auto mode approves every tool call whatever its stake, as in Chat.tsx.
  // It is this session's mode: another session's approvals are unaffected.
  if (s.mode === "auto") {
    return true;
  }
  if (event.stake === "never_ask") {
    return true;
  }
  const cacheKey = {
    mcpServerName: event.metadata.mcpServerName,
    toolName: event.metadata.toolName,
  };
  if (event.stake === "low") {
    const cached = await toolsCache.getCachedApproval(cacheKey);
    if (cached !== null) {
      return cached;
    }
  }

  const decision = await ask(s, {
    id: newId(),
    type: "tool",
    tool: event.metadata.toolName,
    stake: event.stake ?? "high",
    inputs: JSON.stringify(event.inputs, null, 2).slice(0, 4000),
    canRemember: event.stake === "low",
  });
  if (decision.kind === "approve-remember" && event.stake === "low") {
    await toolsCache.setCachedApproval(cacheKey);
  }
  return decision.kind !== "reject";
}

// ------------------------------------------------------------------ turns

// Defensive, on top of the composer's own guard: an identical message arriving
// again within this window of the last one accepted (sent or queued) is the
// same keypress delivered twice, not a second request. See the 2026-10 bug
// where one Enter produced six real turns.
const DUPLICATE_WINDOW_MS = 2000;

// A compaction makes the conversation busy exactly like a running turn does
// (AGENTS.md): every gate that asks "can a message go out now?" uses this. A
// message waiting for a free slot under the concurrency cap counts too, so a
// later message queues behind it instead of overtaking it.
function isConversationBusy(s: Session): boolean {
  return s.busy || s.compacting !== null || s.slotWait;
}

export function send(text: string): Result {
  const s = current();
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: "Empty message." };
  }
  if (!folder) {
    return { ok: false, error: "Choose a working folder first." };
  }
  if (!agentOf(s)) {
    return { ok: false, error: "No agent selected." };
  }
  if (s.attachments.some((a) => a.status === "uploading")) {
    return { ok: false, error: "Wait for the attachments to finish uploading." };
  }
  if (loadingConversationId) {
    return { ok: false, error: "Wait for the conversation to finish opening." };
  }
  const now = Date.now();
  if (
    s.lastAccepted &&
    s.lastAccepted.text === trimmed &&
    now - s.lastAccepted.at < DUPLICATE_WINDOW_MS
  ) {
    // Never silent: the composer gives the text back with this message, so a
    // repeat the user really meant is one more Enter away (after the window).
    // Queue drains and loop ticks do not come through here.
    return {
      ok: false,
      error: "Not sent: the same message went out less than 2 seconds ago. Send it again to repeat it.",
    };
  }
  s.lastAccepted = { text: trimmed, at: now };

  // Failed uploads are dropped; ready ones travel with this message.
  const files: UploadedFile[] = s.attachments
    .filter((a) => a.status === "ready" && a.fileId)
    .map((a) => ({
      id: a.id,
      fileId: a.fileId as string,
      name: a.name,
      size: a.size,
      contentType: a.contentType,
      isImage: a.isImage,
    }));
  s.attachments = [];
  // A message is on its way into it, so the conversation the uploads created
  // is no longer a discard candidate (a /clear-files now must not delete it).
  s.filesOnlyConversationId = null;
  dispatch(s, { id: newId(), text: trimmed, files });
  return { ok: true };
}

function dispatch(s: Session, message: QueuedMessage): void {
  s.queue.push(message);
  if (isConversationBusy(s)) {
    stateChanged(s);
    return;
  }
  startOrWait(s);
}

/**
 * Runs `s`'s next queued message if a slot is free, otherwise parks the session
 * in the FIFO of sessions waiting for one. Synchronous up to the point the turn
 * marks itself busy, so no other send can slip in between.
 */
function startOrWait(s: Session): void {
  if (s.disposed || s.busy || s.compacting !== null) {
    return;
  }
  if (s.queue.length === 0) {
    s.slotWait = false;
    slotWaiters = slotWaiters.filter((w) => w !== s);
    return;
  }
  const waitingAhead = slotWaiters.some((w) => w !== s);
  if (runningCount() < maxParallel && !waitingAhead) {
    s.slotWait = false;
    slotWaiters = slotWaiters.filter((w) => w !== s);
    const next = s.queue.shift();
    if (next) {
      void runTurn(s, next);
    }
    return;
  }
  if (!slotWaiters.includes(s)) {
    slotWaiters.push(s);
  }
  s.slotWait = true;
  stateChanged(s);
}

/** A slot freed (or the cap was raised): start waiting sessions, oldest first. */
function pumpSlots(): void {
  while (slotWaiters.length > 0 && runningCount() < maxParallel) {
    const w = slotWaiters.shift() as Session;
    w.slotWait = false;
    if (w.disposed || w.busy || w.compacting !== null) {
      continue;
    }
    const next = w.queue.shift();
    if (next) {
      void runTurn(w, next);
    } else {
      stateChanged(w);
    }
  }
}

// Called whenever something that made the conversation busy ends (a turn, a
// compaction).
function drainQueue(s: Session): void {
  if (s.disposed || s.busy || s.compacting !== null) {
    return;
  }
  startOrWait(s);
  pumpSlots();
}

export function recallQueued(): Result<string | null> {
  const s = current();
  // A loop tick is not the user's text to edit; leave those to /loop stop.
  let index = s.queue.length - 1;
  while (index >= 0 && s.queue[index].loop) {
    index--;
  }
  if (index < 0) {
    return { ok: true, value: null };
  }
  const [last] = s.queue.splice(index, 1);
  if (s.slotWait && s.queue.length === 0) {
    s.slotWait = false;
    slotWaiters = slotWaiters.filter((w) => w !== s);
  }
  stateChanged(s);
  return { ok: true, value: last.text };
}

function setConversation(s: Session, id: string | null, title: string | null): void {
  s.conversationId = id;
  s.conversationTitle = title;
}

function headerDetail(s: Session, agent: AgentConfiguration): string | null {
  const model = s.modelOverride?.modelId ?? agent.model?.modelId ?? null;
  const parts = [model, s.effort].filter(Boolean) as string[];
  return parts.length ? parts.join(" · ") : null;
}

async function runTurn(s: Session, message: QueuedMessage): Promise<void> {
  const text = message.text;
  const agent = agentOf(s);
  if (!agent || !me) {
    return;
  }
  // Once the session is torn down (sign-out) or retired, this turn's late
  // output is dropped.
  const turnEpoch = s.epoch;
  const append = (item: TranscriptItem) => {
    if (s.epoch === turnEpoch) appendItem(s, item);
  };
  const noteHere = (tone: "info" | "error", line: string) =>
    append({ kind: "note", id: newId(), tone, text: line });
  s.busy = true;
  s.slotWait = false;
  s.unread = false;
  s.errored = false;
  // Nothing is drawn for the agent until it has something to show: a header
  // with nothing under it is what produced tall empty blocks. Until then the
  // renderer shows one compact "thinking" row from this.
  s.pendingAgent = { name: agent.name, detail: headerDetail(s, agent) };
  let headerShown = false;
  const ensureHeader = () => {
    if (headerShown) {
      return;
    }
    headerShown = true;
    s.pendingAgent = null;
    append({
      kind: "agent-header",
      id: newId(),
      agentName: agent.name,
      detail: headerDetail(s, agent),
    });
    stateChanged(s);
  };
  s.thinking = false;
  s.actionLabel = null;
  s.notice = null;
  const turnController = new AbortController();
  s.controller = turnController;
  const signal = turnController.signal;
  s.activeAgentMessageId = null;
  stateChanged(s);
  let failed = false;
  let endReason = "finished";
  s.stopRequested = false;

  append({
    kind: "user",
    id: newId(),
    text,
    ...(message.files.length ? { attachments: message.files.map((f) => f.name) } : {}),
  });

  // Streaming text buffer: deltas are batched so a fast stream costs the
  // renderer ~20 updates a second, not one per token.
  let blockId: string | null = null;
  let pendingText = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let streamed = "";

  const flush = () => {
    flushTimer = null;
    if (blockId && pendingText) {
      tx(s, { type: "text-delta", id: blockId, text: pendingText });
      pendingText = "";
    }
  };
  const pushText = (chunk: string) => {
    ensureHeader();
    if (!blockId) {
      blockId = newId();
      append({ kind: "agent-text", id: blockId, text: "", streaming: true });
    }
    pendingText += chunk;
    streamed += chunk;
    s.inFlightText = streamed;
    if (!flushTimer) {
      flushTimer = setTimeout(flush, 50);
    }
  };
  const closeBlock = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
    }
    flush();
    if (blockId) {
      tx(s, {
        type: "patch",
        id: blockId,
        patch: { streaming: false } as never,
      });
      blockId = null;
    }
  };

  const toolStarts = new Map<string, number>();
  let lastUsageRefresh = 0;

  try {
    const dust = await currentClient();
    if (!dust) {
      await sessionExpired("Your session expired. Sign in again.");
      throw new Error("Not signed in.");
    }
    s.activeClient = dust;

    // File tools need this session's fs MCP server attached before the first
    // message.
    await ensureFsServer(s);

    // Plan mode is restated on every message while it is on.
    let sentText =
      s.mode === "plan"
        ? `${planModePreamble()}\n\n${text}\n\n${planModeReminder()}`
        : text;

    // Local skills (see skillStore.ts and AGENTS.md): the catalogue is
    // re-read every send and only injected when it differs from the last one
    // sent; forced bodies from /skills <name> ride along once. Gated on the fs
    // MCP server being attached, since without it read_skill is not callable.
    const forcedSkillsThisTurn = s.pendingForcedSkills;
    let skillsBlockIncluded = false;
    let freshSkillCatalogue: string | null | undefined;
    if (s.fsServerId) {
      const skillSet = await loadSkills({ includeClaudeSkills: s.claudeCodeMode });
      freshSkillCatalogue = buildSkillCatalogue(skillSet);
      const block = buildSkillsBlock({
        catalogue:
          freshSkillCatalogue !== s.lastSentSkillCatalogue ? freshSkillCatalogue : null,
        inlined: forcedSkillsThisTurn,
        revision: s.skillRevision + 1,
      });
      if (block) {
        sentText = `${block}\n\n${sentText}`;
        skillsBlockIncluded = true;
      }
    } else if (forcedSkillsThisTurn.length > 0) {
      const block = buildSkillsBlock({
        catalogue: null,
        inlined: forcedSkillsThisTurn,
        revision: s.skillRevision + 1,
      });
      if (block) {
        sentText = `${block}\n\n${sentText}`;
        skillsBlockIncluded = true;
      }
    }

    // Claude Code mode's one-time priming. The latch is only cleared once
    // the API has accepted the message (below), so a failed send does not
    // lose the memories for the rest of the conversation.
    const primingThisMessage = s.pendingClaudePriming && s.claudeContext !== null;
    if (primingThisMessage && s.claudeContext) {
      sentText = `${buildPrimingBlock(s.claudeContext)}\n\n${sentText}`;
    }

    const modelSelection = buildModelSelection(
      s.modelOverride,
      s.effort,
      agent.model
        ? { modelId: agent.model.modelId, providerId: agent.model.providerId }
        : null
    );
    const context = {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      username: me.username,
      fullName: me.fullName,
      email: me.email,
      origin: "cli" as const,
      // THIS session's server only: Dust routes this message's tool calls
      // there, which is what makes per-session plan mode exact.
      clientSideMCPServerIds: s.fsServerId ? [s.fsServerId] : null,
    };
    s.turnFsServerId = s.fsServerId;

    let conversation: Conversation;
    let userMessageId: string;

    if (!s.conversationId) {
      const convRes = await dust.createConversation({
        title: text.substring(0, 50) + (text.length > 50 ? "..." : ""),
        visibility: "unlisted",
        message: {
          content: sentText,
          mentions: [{ configurationId: agent.sId }],
          context,
          // A sibling of content/mentions/context, not nested in context
          // (AGENTS.md). Both send sites need it.
          ...(modelSelection ? { modelSelection } : {}),
        },
        contentFragments: [],
      });
      if (convRes.isErr()) {
        throw new Error(`Failed to create conversation: ${convRes.error.message}`);
      }
      conversation = convRes.value.conversation;
      if (!convRes.value.message) {
        throw new Error("No message created");
      }
      userMessageId = convRes.value.message.sId;
      if (s.epoch !== turnEpoch) {
        throw new Error("Signed out.");
      }
      setConversation(s, conversation.sId, conversation.title ?? text.slice(0, 50));
      emit({ type: "conversations-changed" });
    } else {
      const conversationId = s.conversationId;
      // Files attached to this message become content fragments first, the
      // same order the CLI uses.
      for (const file of message.files) {
        const fragmentRes = await dust.postContentFragment({
          conversationId,
          contentFragment: { title: file.name, fileId: file.fileId },
        });
        if (fragmentRes.isErr()) {
          throw new Error(
            `Failed to attach ${file.name}: ${fragmentRes.error.message}`
          );
        }
      }
      const messageRes = await dust.postUserMessage({
        conversationId,
        message: {
          content: sentText,
          mentions: [{ configurationId: agent.sId }],
          context,
          ...(modelSelection ? { modelSelection } : {}),
        },
      });
      if (messageRes.isErr()) {
        throw new Error(`Error creating message: ${messageRes.error.message}`);
      }
      userMessageId = messageRes.value.sId;
      const convRes = await dust.getConversation({ conversationId });
      if (convRes.isErr()) {
        throw new Error(`Error retrieving conversation: ${convRes.error.message}`);
      }
      conversation = convRes.value;
    }
    // The message is on the server now, so the one-shot state can be
    // committed (committing earlier would desync it on a failed send).
    if (primingThisMessage) {
      s.pendingClaudePriming = false;
    }
    if (skillsBlockIncluded) {
      s.skillRevision += 1;
    }
    if (freshSkillCatalogue !== undefined) {
      s.lastSentSkillCatalogue = freshSkillCatalogue;
    }
    s.pendingForcedSkills = [];
    stateChanged(s);

    if (!testClient) void appendTranscriptEntry(conversation.sId, {
      role: "user",
      text: sentText,
      messageId: userMessageId,
    });

    const streamRes = await retryResult(() =>
      dust.streamAgentAnswerEvents({ conversation, userMessageId, signal })
    );
    if (streamRes.isErr()) {
      throw new Error(`Failed to stream agent answer: ${streamRes.error.message}`);
    }

    // The stream is read by hand and raced against the abort signal: after an
    // abort the SDK's stream can fail to end (it logs "Failed processing event
    // stream" and keeps retrying), which once left a turn "Thinking" forever.
    // An abort must end the turn whatever the iterator does.
    const iterator = streamRes.value.eventStream[Symbol.asyncIterator]();
    const aborted = new Promise<"aborted">((resolve) => {
      if (signal.aborted) resolve("aborted");
      else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    while (true) {
      const step = await Promise.race([iterator.next(), aborted]);
      if (step === "aborted") {
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
        throw new Error("aborted");
      }
      if (step.done) {
        break;
      }
      const event = step.value;
      if (s.epoch !== turnEpoch) {
        break; // torn down (sign-out); teardownSession cancelled server-side
      }
      if (!s.activeAgentMessageId && "messageId" in event && event.messageId) {
        s.activeAgentMessageId = event.messageId;
      }

      if (event.type === "generation_tokens") {
        if (event.classification === "tokens") {
          if (s.thinking) {
            s.thinking = false;
            stateChanged(s);
          }
          pushText(event.text);
        } else if (event.classification === "chain_of_thought" && !s.thinking) {
          s.thinking = true;
          stateChanged(s);
        }
      } else if (event.type === "agent_error") {
        throw new Error(`Agent error: ${event.error.message}`);
      } else if (event.type === "user_message_error") {
        throw new Error(`User message error: ${event.error.message}`);
      } else if (event.type === "agent_generation_cancelled") {
        closeBlock();
        endReason = "stopped (server confirmed the cancel)";
        noteHere("info", s.stopRequested ? "Stopped by you." : "Stopped.");
        break;
      } else if (event.type === "agent_message_success") {
        closeBlock();
        if (!streamed && event.message.content) {
          pushText(event.message.content);
          closeBlock();
        }
        if (!testClient) void appendTranscriptEntry(conversation.sId, {
          role: "agent",
          text: streamed,
          messageId: event.message.sId,
        });
        break;
      } else if (event.type === "tool_params") {
        ensureHeader();
        closeBlock();
        s.thinking = false;
        const name = event.action.toolName;
        s.currentToolName = name;
        const startedAt = Date.now();
        toolStarts.set(event.action.sId, startedAt);
        s.actionLabel = event.action.displayLabels?.running ?? "Running a tool";
        append({
          kind: "tool",
          id: event.action.sId,
          name,
          detail: describeToolCall(
            name,
            (event.action.params ?? {}) as Record<string, unknown>
          ),
          status: "running",
          startedAt,
          durationMs: null,
        });
        stateChanged(s);
      } else if (event.type === "agent_action_success") {
        const started = toolStarts.get(event.action.sId);
        s.actionLabel = null;
        tx(s, {
          type: "patch",
          id: event.action.sId,
          patch: {
            status: event.action.status === "errored" ? "error" : "ok",
            durationMs:
              event.action.executionDurationMs ??
              (started ? Date.now() - started : null),
          } as never,
        });
        stateChanged(s);
        // A completed tool call is a natural checkpoint for the numbers.
        if (Date.now() - lastUsageRefresh > 8000) {
          lastUsageRefresh = Date.now();
          void refreshUsage(s);
        }
      } else if (event.type === "tool_approve_execution") {
        const approved = await handleToolApproval(s, event);
        if (!approved) {
          tx(s, {
            type: "patch",
            id: event.actionId,
            patch: { status: "rejected" } as never,
          });
        }
        await dust.validateAction({
          conversationId: event.conversationId,
          messageId: event.messageId,
          actionId: event.actionId,
          approved: approved ? "approved" : "rejected",
        });
      }
    }
    closeBlock();
    void refreshUsage(s);
  } catch (error) {
    closeBlock();
    if (s.epoch !== turnEpoch) {
      // Torn down mid-turn: nothing to report into a conversation that is gone.
    } else if (signal.aborted) {
      endReason = s.stopRequested ? "stopped by the user" : "aborted";
      noteHere("info", s.stopRequested ? "Stopped by you." : "Stopped.");
    } else {
      const recovered = streamed ? null : await tryRecover(s);
      if (recovered) {
        append({
          kind: "agent-text",
          id: newId(),
          text: recovered,
          streaming: false,
        });
      } else {
        failed = true;
        endReason = "error";
        const errorText = normalizeError(error).message;
        noteHere(
          "error",
          s.conversationId
            ? `${errorText}\n\nConversation: ${s.conversationId}`
            : errorText
        );
        if (/token|unauthor|401|not signed in/i.test(errorText)) {
          void sessionExpired("Your session expired. Sign in again.");
        }
      }
    }
  } finally {
    if (s.cancelFallback) {
      clearTimeout(s.cancelFallback);
      s.cancelFallback = null;
    }
    // A torn-down turn can finish after the session was replaced; its handles
    // then belong to nobody.
    if (s.controller === turnController) {
      // Why the turn ended, for the log (a turn that stops by itself is the
      // one thing the user cannot otherwise explain).
      console.log(`[dustm] session ${s.key} turn ended: ${endReason}`);
      s.busy = false;
      s.thinking = false;
      s.actionLabel = null;
      s.pendingAgent = null;
      s.inFlightText = "";
      s.controller = null;
      s.activeClient = null;
      s.activeAgentMessageId = null;
      rejectAllPending(s);
      if (!s.disposed && s !== selected) {
        // Finished while another conversation was on screen: the sidebar
        // marks it until it is looked at.
        if (failed) s.errored = true;
        else s.unread = true;
        // Nothing needs the tools until the next turn.
        closeFsServer(s);
      }
      stateChanged(s);
      emit({ type: "conversations-changed" });
      if (!signal.aborted && s.epoch === turnEpoch) {
        toast(s, failed ? "error" : "finished", failed ? "the turn failed" : streamed);
      }
      // A slot is free: whoever has waited longest goes first, then this
      // session's own queue (anything typed while the agent was busy).
      drainQueue(s);
    }
    pumpSlots();
  }
}

// The @dust-tt/client SSE "done" sentinel can exhaust its reconnect budget
// even though the answer landed; check the server before reporting failure.
async function tryRecover(s: Session): Promise<string | null> {
  const conversationId = s.conversationId;
  if (!conversationId) {
    return null;
  }
  const clientRes = await getDustClient();
  const dust = clientRes.isOk() ? clientRes.value : null;
  if (!dust) {
    return null;
  }
  const res = await dust.getConversation({ conversationId });
  if (res.isErr()) {
    return null;
  }
  let last: string | null = null;
  for (const group of res.value.content) {
    for (const msg of group) {
      if (msg.type === "agent_message" && msg.content) {
        last = msg.content;
      }
    }
  }
  return last;
}

// After a successful server-side cancel the turn normally ends on the
// stream's agent_generation_cancelled event. If that never arrives (a dropped
// stream that the SDK keeps retrying), the local stream is aborted after this
// long so the app cannot stay "busy" with the queue stuck behind it.
export const CANCEL_FALLBACK_MS = 8000;

export async function cancel(source = "internal", sid: string | null = null): Promise<Result> {
  const s = current();
  // The renderer says which session it was showing. If another one is on
  // screen by the time this arrives (a notification click, a switch in
  // flight), the stop was not meant for it: refuse rather than stop the
  // wrong turn. Main-internal callers pass no sid.
  if (sid !== null && sid !== s.key) {
    console.log(`[dustm] cancel by ${source} ignored: aimed at ${sid}, ${s.key} is on screen`);
    return { ok: false, error: "That conversation is no longer on screen." };
  }
  // Like Esc in the CLI, stopping also ends a running loop.
  stopLoopOf(s, "stopped");
  console.log(`[dustm] session ${s.key} cancel requested by ${source} (busy=${s.busy})`);
  if (s.busy) s.stopRequested = true;
  if (!s.busy) {
    if (s.slotWait) {
      // Waiting for a slot: stopping drops what was waiting.
      s.queue = [];
      s.slotWait = false;
      slotWaiters = slotWaiters.filter((w) => w !== s);
      note(s, "info", "Removed the message that was waiting for a free slot.");
      stateChanged(s);
    }
    return { ok: true };
  }
  // Pending dialogs would otherwise hold the stream open forever.
  rejectAllPending(s);
  const turnController = s.controller;
  if (s.activeClient && s.conversationId && s.activeAgentMessageId) {
    s.actionLabel = "Stopping...";
    stateChanged(s);
    // A real server-side cancel: aborting the local stream alone would leave
    // the agent running (and spending credits) in the background.
    const res = await s.activeClient.cancelMessageGeneration({
      conversationId: s.conversationId,
      messageIds: [s.activeAgentMessageId],
    });
    if (!res.isErr()) {
      if (!s.cancelFallback && turnController) {
        s.cancelFallback = setTimeout(() => {
          s.cancelFallback = null;
          if (s.controller === turnController) {
            turnController.abort();
          }
        }, CANCEL_FALLBACK_MS);
      }
      return { ok: true };
    }
  }
  turnController?.abort();
  return { ok: true };
}

// ------------------------------------------------------------------ conversations

export async function listConversations(): Promise<Result<ConversationSummary[]>> {
  const clientRes = await getDustClient();
  if (clientRes.isErr() || !clientRes.value) {
    return { ok: false, error: "Not signed in." };
  }
  const res = await clientRes.value.getConversations();
  if (res.isErr()) {
    return { ok: false, error: `Failed to fetch conversations: ${res.error.message}` };
  }
  const list = res.value
    .filter((c) => c.visibility !== "deleted")
    .map((c) => ({
      sId: c.sId,
      title: c.title || "Untitled",
      updated: c.updated ?? c.created,
    }))
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 200);
  for (const c of list) {
    knownTitles.set(c.sId, c.title);
  }
  return { ok: true, value: list };
}

// Timings of the last conversation load, for the profile smoke path.
export const lastLoadTimings: Record<string, number> = {};

/** Switches to a live session (a draft, or one running in the background). */
export function selectSession(key: string): Result {
  const target = sessions.get(key);
  if (!target) {
    return { ok: false, error: "That session is gone." };
  }
  // Any load in flight is superseded: its result is dropped via loadSeq.
  loadSeq++;
  loadingConversationId = null;
  if (target === selected) {
    emitState();
    return { ok: true };
  }
  select(target);
  return { ok: true };
}

/**
 * Opens a conversation. If a session for it is already live (running in the
 * background, waiting on an approval...) it is simply selected - nothing is
 * refetched. Otherwise the history is fetched, and while that is in flight any
 * newer switch supersedes it: the stale result is dropped (loadSeq), instead of
 * the UI being locked until it lands.
 */
export async function loadConversation(id: string): Promise<Result> {
  const seq = ++loadSeq;
  const existing = findByConversation(id);
  if (existing) {
    loadingConversationId = null;
    if (existing === selected) {
      emitState();
    } else {
      select(existing);
    }
    return { ok: true };
  }
  loadingConversationId = id;
  emitState();
  try {
    const t0 = performance.now();
    const agentName = agentOf(current())?.name ?? "dust";
    // Fast path: only the newest messages (history.ts explains why).
    const page = testClient ? null : await fetchHistoryPage(id, { limit: 30, agentName });
    let items: TranscriptItem[];
    let title: string | null;
    let cursor: number | null;
    let t1 = performance.now();
    if (page) {
      items = page.items;
      title = knownTitles.get(id) ?? null;
      cursor = page.hasMore ? page.cursor : null;
    } else {
      // Fallback: the public full load.
      const dust = await currentClient();
      if (!dust) {
        return { ok: false, error: "Not signed in." };
      }
      const res = await dust.getConversation({ conversationId: id });
      t1 = performance.now();
      if (res.isErr()) {
        return { ok: false, error: `Failed to load conversation: ${res.error.message}` };
      }
      items = itemsFromConversation(res.value, agentName);
      title = res.value.title ?? null;
      cursor = null;
    }
    const t2 = performance.now();
    const loadedTasks = await loadTasks(id);
    if (seq !== loadSeq) {
      return { ok: true }; // superseded by a newer switch: drop the stale result
    }
    // Another path (a turn creating this very conversation) may have made a
    // live session for it while the history was in flight.
    const raced = findByConversation(id);
    if (raced) {
      loadingConversationId = null;
      select(raced);
      return { ok: true };
    }
    const next = createSession(current(), prefsByConversation.get(id) ?? null);
    setConversation(next, id, title);
    next.items = items;
    next.earlierCursor = cursor;
    next.tasks = loadedTasks;
    loadingConversationId = null;
    select(next);
    const t3 = performance.now();
    Object.assign(lastLoadTimings, {
      path: page ? 1 : 0,
      fetchAndParseMs: Math.round(t1 - t0),
      buildItemsMs: Math.round(t2 - t1),
      emitMs: Math.round(t3 - t2),
      items: items.length,
    });
    return { ok: true };
  } finally {
    if (seq === loadSeq && loadingConversationId === id) {
      loadingConversationId = null;
      emitState();
    }
  }
}

/** Fetches the page of messages before the oldest one on screen. */
export async function loadEarlier(): Promise<Result> {
  const s = current();
  const id = s.conversationId;
  if (!id || s.earlierCursor === null || s.loadingEarlier) {
    return { ok: true };
  }
  s.loadingEarlier = true;
  stateChanged(s);
  try {
    const page = await fetchHistoryPage(id, {
      limit: 30,
      beforeRank: s.earlierCursor,
      agentName: agentOf(s)?.name ?? "dust",
    });
    if (!page) {
      return { ok: false, error: "Could not load earlier messages." };
    }
    if (s.disposed || s.conversationId !== id) {
      return { ok: true }; // the session moved on; drop the stale page
    }
    s.earlierCursor = page.hasMore ? page.cursor : null;
    tx(s, { type: "transcript-prepend", items: page.items });
    return { ok: true };
  } finally {
    s.loadingEarlier = false;
    stateChanged(s);
  }
}

/**
 * /new and /clear: a fresh draft session becomes the view. The session it
 * replaces on screen is NOT touched: if it is running it keeps going in the
 * background; if it is idle it is retired (select() does that).
 */
export function newConversation(): Result {
  // A fresh switch supersedes any load in flight.
  loadSeq++;
  loadingConversationId = null;
  const cur = current();
  if (
    !cur.conversationId &&
    cur.items.length === 0 &&
    cur.attachments.length === 0 &&
    !cur.busy &&
    !cur.slotWait
  ) {
    // Already on an empty draft.
    emitView();
    return { ok: true };
  }
  select(createSession(cur));
  return { ok: true };
}

export function selectAgent(id: string, persist = true): Result {
  if (!agents.some((a) => a.sId === id)) {
    return { ok: false, error: "Unknown agent." };
  }
  // Per session: switching agent while looking at B must not change who A is
  // talking to. It is also the default for the next new conversation.
  current().agentId = id;
  defaultAgentId = id;
  if (persist) {
    void updateSettings({ agentId: id });
  }
  emitState();
  return { ok: true };
}

// ------------------------------------------------------------------ model & effort

async function catalogue(): Promise<{
  models: ModelChoice[];
  source: "live" | "fallback";
  degraded: Set<string>;
}> {
  const live = await getWorkspaceModels();
  return live
    ? { models: live.models, source: "live", degraded: live.degradedModelIds }
    : { models: MODEL_CATALOG, source: "fallback", degraded: new Set() };
}

export async function listModels(): Promise<Result<ModelList>> {
  const { models, source, degraded } = await catalogue();
  const agentModelId = agentOf(current())?.model?.modelId ?? null;
  const rows: ModelRow[] = models.map((m) => {
    const tags: string[] = [];
    if (degraded.has(m.modelId)) tags.push("degraded");
    if (m.note === "legacy") tags.push("legacy");
    else if (m.note && m.note !== "not in catalogue") tags.push(m.note);
    if (m.modelId === agentModelId) tags.push("current");
    return {
      modelId: m.modelId,
      providerId: m.providerId,
      label: m.label,
      contextSize: m.contextSize ?? null,
      tags,
    };
  });
  // Grouped by provider in a stable, familiar order (the API's own order is
  // arbitrary); the Dust-routed "auto" selectors go last.
  const rank = (p: string) => {
    const order = ["anthropic", "openai", "google_ai_studio", "mistral", "xai", "deepseek", "fireworks"];
    const i = order.indexOf(p);
    return i === -1 ? (p.startsWith("auto") ? 99 : 50) : i;
  };
  rows.sort((a, b) => rank(a.providerId) - rank(b.providerId));
  return { ok: true, value: { source, models: rows, agentModelId } };
}

export async function setModel(query: string | null): Promise<Result> {
  const s = current();
  if (query === null) {
    s.modelOverride = null;
    stateChanged(s);
    return { ok: true };
  }
  const { models } = await catalogue();
  // resolveModel also accepts ids outside the list when a provider can be
  // inferred; the server is the only thing that can say a model is invalid.
  const choice = resolveModel(query, models);
  if (!choice) {
    return { ok: false, error: `Unknown model "${query}".` };
  }
  s.modelOverride = choice;
  stateChanged(s);
  return { ok: true };
}

export function setEffort(next: Effort | null): Result {
  const allowed = ["high", "medium", "light", "none"];
  if (next !== null && !allowed.includes(next)) {
    return { ok: false, error: "Unknown effort." };
  }
  const s = current();
  s.effort = next;
  stateChanged(s);
  return { ok: true };
}

// ------------------------------------------------------------------ usage

async function refreshUsage(s: Session): Promise<void> {
  if (testClient) {
    return;
  }
  const forConversation = s.conversationId;
  const forEpoch = s.epoch;
  const forIdentity = identityEpoch;
  const [context, credits] = await Promise.all([
    forConversation ? getContextUsage(forConversation) : Promise.resolve(null),
    getConsumedCredits(),
  ]);
  if (forIdentity !== identityEpoch) {
    return; // signed out meanwhile
  }
  // Credits are account-wide, so they are kept whatever became of the session.
  if (credits) {
    creditsUsage = { consumed: credits.consumed, limit: credits.limit };
  }
  if (s.disposed || forEpoch !== s.epoch || forConversation !== s.conversationId) {
    // The session was retired or moved to another conversation while this was
    // in flight: its context figure belongs to the old one.
    if (selected) stateChanged(selected);
    return;
  }
  if (context) {
    s.context = {
      used: context.contextUsage,
      size: context.contextSize,
      modelId: context.modelId,
    };
  }
  stateChanged(s);
  if (s !== selected && selected) {
    stateChanged(selected);
  }
}

// ------------------------------------------------------------------ commands
//
// The slash commands whose behaviour lives here (the rest are pure UI and are
// handled in the renderer: /help /switch /resume /model /effort /attach
// /plan /auto /new /clear /exit). Each is a port of the matching handler in
// src/ui/commands/Chat.tsx, reusing the shared modules and keeping the rules
// AGENTS.md states for them. Each acts on the session on screen.

function noteLines(s: Session, lines: string[]): void {
  note(s, "info", lines.join("\n"));
}

export async function runCommand(name: string, args: string): Promise<Result> {
  const s = current();
  switch (name) {
    case "compact":
      return runCompact(s, args);
    case "btw":
      return runBtw(s, args);
    case "loop":
      return runLoop(s, args);
    case "skills":
      return runSkills(s, args);
    case "claude-code-mode":
      return toggleClaudeCodeMode(s);
    case "tasks":
      return runTasks(s);
    case "clear-files":
      s.attachments = [];
      discardIfNothingAttached(s);
      stateChanged(s);
      return { ok: true };
    default:
      return { ok: false, error: `Unknown command /${name}.` };
  }
}

async function runTasks(s: Session): Promise<Result> {
  if (!s.conversationId) {
    noteLines(s, [
      "Tasks: none yet.",
      "  todo_write creates the list the first time the agent calls it.",
    ]);
    return { ok: true };
  }
  const list = await loadTasks(s.conversationId);
  noteLines(s, ["Tasks:", ...formatTaskList(list).split("\n")]);
  return { ok: true };
}

// ---------------------------------------------------------------- /compact

function runCompact(s: Session, args: string): Result {
  const id = s.conversationId;
  if (!id) {
    noteLines(s, [
      "Nothing to compact - this conversation hasn't started yet.",
      "  Send a message first.",
    ]);
    return { ok: true };
  }
  if (s.compacting) {
    noteLines(s, ["A compaction is already running - give it a moment."]);
    return { ok: true };
  }
  // Busy gating is per conversation: another session's turn is irrelevant.
  if (s.busy) {
    noteLines(s, [
      "The agent is still working - a turn has to finish before compacting.",
      "  Wait for it (or stop it), then run /compact again.",
    ]);
    return { ok: true };
  }
  // Marked busy before any await, so a message typed meanwhile queues
  // instead of racing the compaction server-side (the bug this shipped with
  // in the CLI: see AGENTS.md).
  s.compacting = "Compacting…";
  stateChanged(s);
  const compactEpoch = s.epoch;
  void (async () => {
    // A sign-out mid-compaction replaces the session; its outcome must not be
    // written into whatever comes next.
    const say = (lines: string[]) => {
      if (s.epoch === compactEpoch) noteLines(s, lines);
    };
    try {
      const query = args.trim() || undefined;
      const { models } = await catalogue();
      if (query && !resolveModel(query, models)) {
        say([
          `Unknown model "${query}".`,
          "  /compact takes the same model ids /model does.",
        ]);
        return;
      }
      const before = await getContextUsage(id);
      const agent = agentOf(s);
      const chosen = resolveCompactionModel({
        query,
        override: s.modelOverride,
        conversationModel: before,
        agentModel: agent?.model
          ? { modelId: agent.model.modelId, providerId: agent.model.providerId }
          : null,
        catalogue: models,
      });
      if (!chosen) {
        say([
          "No model to summarize with.",
          "  Compaction has to name a concrete provider/model pair. This agent",
          "  runs on an `auto` selector, which only resolves to one per message,",
          "  and the conversation hasn't run a turn yet for one to be read from.",
          "  Send a message first, or name one: /compact <model-id>.",
        ]);
        return;
      }
      s.compacting = `Compacting with ${chosen.label}…`;
      stateChanged(s);
      const started = await startCompaction({
        conversationId: id,
        model: { providerId: chosen.providerId, modelId: chosen.modelId },
      });
      if (!started.ok) {
        // The server's wording is shown verbatim: each 409 tells the user a
        // different thing to do.
        say([
          `Compaction failed: ${started.message}`,
          ...(started.detail ? [`  ${started.detail}`] : []),
        ]);
        return;
      }
      const outcome = await waitForCompaction({
        conversationId: id,
        compactionMessageId: started.compactionMessageId,
      });
      if (outcome.status === "timeout") {
        say([
          "Compaction is taking longer than expected - still running server-side.",
          "  The context figure will drop when it lands.",
        ]);
        return;
      }
      if (outcome.status === "failed") {
        say([
          "Compaction failed server-side. Nothing was changed.",
          "  Long conversations may keep degrading; /new starts a fresh one.",
        ]);
        return;
      }
      const after = await getContextUsage(id);
      say([
        "Compacted.",
        ...(before && after
          ? [
              `  Context: ${Math.round(before.contextUsage / 1000)}k -> ${Math.round(
                after.contextUsage / 1000
              )}k of ${Math.round(after.contextSize / 1000)}k`,
            ]
          : []),
        "  Everything above is still on screen, but the agent now sees",
        "  a summary of it rather than the full text.",
      ]);
      void refreshUsage(s);
    } catch (error) {
      say([`Compaction failed: ${normalizeError(error).message}`]);
    } finally {
      s.compacting = null;
      if (s !== selected && !s.disposed) s.unread = true;
      stateChanged(s);
      drainQueue(s);
    }
  })();
  return { ok: true };
}

// -------------------------------------------------------------------- /btw

function runBtw(s: Session, args: string): Result {
  const question = args.trim();
  if (!question) {
    noteLines(s, [
      "Usage: /btw <question>",
      "  Asks the agent a quick side question. The answer is shown here but",
      "  never added to the conversation, and it works while a turn is running.",
    ]);
    return { ok: true };
  }
  const agent = agentOf(s);
  if (!agent || !me) {
    noteLines(s, ["/btw: no agent selected yet."]);
    return { ok: true };
  }
  if (s.btwStatus !== null) {
    noteLines(s, ["A /btw question is already being answered - give it a moment."]);
    return { ok: true };
  }
  const modelSelection = buildModelSelection(
    s.modelOverride,
    s.effort,
    agent.model
      ? { modelId: agent.model.modelId, providerId: agent.model.providerId }
      : null
  );
  const user = { username: me.username, fullName: me.fullName, email: me.email };
  const id = newId();
  s.btwStatus = `btw: asking @${agent.name}…`;
  appendItem(s, { kind: "btw", id, question, status: "pending", answer: "" });
  stateChanged(s);

  // Deliberately NOT part of isConversationBusy (utils/btw.ts): it runs in a
  // separate conversation, so it cannot race the main turn, and blocking the
  // queue on it would defeat asking mid-turn. Nothing is posted to the main
  // conversation.
  void (async () => {
    try {
      const result = await askBtw({
        question,
        agentId: agent.sId,
        mainConversationId: s.conversationId,
        inFlightAnswer: s.busy ? s.inFlightText : undefined,
        user,
        modelSelection,
      });
      tx(s, {
        type: "patch",
        id,
        patch: (result.ok
          ? { status: "done", answer: result.answer || "(no answer)" }
          : { status: "error", answer: `/btw failed: ${result.message}` }) as never,
      });
    } catch (error) {
      tx(s, {
        type: "patch",
        id,
        patch: { status: "error", answer: normalizeError(error).message } as never,
      });
    } finally {
      s.btwStatus = null;
      if (s !== selected && !s.disposed) s.unread = true;
      stateChanged(s);
    }
  })();
  return { ok: true };
}

// ------------------------------------------------------------------- /loop

function runLoop(s: Session, args: string): Result {
  const parsed = parseLoopCommand(args);
  if (!parsed.ok) {
    noteLines(s, [`↻ ${parsed.error}`]);
    return { ok: true };
  }
  const command = parsed.value;

  if (command.kind === "status") {
    noteLines(
      s,
      s.loop
        ? [
            `↻ Looping ${describeLoop(s.loop)}`,
            `  Prompt: ${s.loop.prompt}`,
            "  /loop stop to cancel.",
          ]
        : [
            "↻ No loop running.",
            "  /loop <interval> <prompt> to start one, e.g. /loop 10m check CI and fix any failures",
            "  Add xN to cap the runs: /loop 10m x5 <prompt>",
          ]
    );
    return { ok: true };
  }
  if (command.kind === "stop") {
    if (!stopLoopOf(s, "cancelled")) {
      noteLines(s, ["↻ No loop running."]);
    }
    return { ok: true };
  }
  if (s.loop) {
    noteLines(s, [
      "↻ A loop is already running - /loop stop it first.",
      `  Currently: ${describeLoop(s.loop)}`,
    ]);
    return { ok: true };
  }
  if (!folder || !agentOf(s)) {
    noteLines(s, ["↻ Choose a working folder (and an agent) before starting a loop."]);
    return { ok: true };
  }

  // The limits (30s floor, run ceiling) live in loopController.ts and are
  // enforced by parseLoopCommand: they exist to stop an unattended loop
  // spending a credit balance.
  s.loop = {
    id: `loop_${Date.now()}`,
    intervalMs: command.intervalMs,
    prompt: command.prompt,
    runs: 0,
    maxRuns: command.maxRuns,
    skipped: 0,
  };
  noteLines(s, [
    `↻ Looping every ${formatInterval(command.intervalMs)}, up to ${command.maxRuns} runs.`,
    `  Prompt: ${command.prompt}`,
    "  Runs once now, then on the interval. Stop or /loop stop to cancel.",
  ]);
  s.loopTimer = setInterval(() => tickLoop(s), command.intervalMs);
  tickLoop(s);
  return { ok: true };
}

// A tick never starts a turn directly: it goes through dispatch() like any
// message, so it queues behind a running turn (and, under the concurrency cap,
// waits for a slot). A tick that fires while its predecessor is still unsent
// or running is skipped, not stacked. The loop belongs to its session: it keeps
// running while another conversation is on screen.
function tickLoop(s: Session): void {
  const running = s.loop;
  if (!running || s.disposed) {
    return;
  }
  if (running.runs >= running.maxRuns) {
    stopLoopOf(s, `reached its ${running.maxRuns}-run limit`);
    return;
  }
  if (isConversationBusy(s) || s.queue.some((m) => m.loop)) {
    s.loop = { ...running, skipped: running.skipped + 1 };
    stateChanged(s);
    return;
  }
  s.loop = { ...running, runs: running.runs + 1 };
  dispatch(s, { id: newId(), text: running.prompt, files: [], loop: true });
  stateChanged(s);
}

function stopLoopOf(s: Session, reason: string, options: { quiet?: boolean } = {}): boolean {
  const running = s.loop;
  if (!running) {
    return false;
  }
  s.loop = null;
  if (s.loopTimer) {
    clearInterval(s.loopTimer);
    s.loopTimer = null;
  }
  // Pending loop ticks go with it.
  s.queue = s.queue.filter((m) => !m.loop);
  if (s.slotWait && s.queue.length === 0) {
    s.slotWait = false;
    slotWaiters = slotWaiters.filter((w) => w !== s);
  }
  if (options.quiet) {
    stateChanged(s);
    return true;
  }
  noteLines(s, [
    `↻ Loop stopped - ${reason}.`,
    `  Ran ${running.runs} of ${running.maxRuns}${
      running.skipped > 0
        ? `, skipped ${running.skipped} tick${running.skipped === 1 ? "" : "s"} while the agent was busy`
        : ""
    }.`,
  ]);
  stateChanged(s);
  return true;
}

/** Stops the loop of the session on screen (smoke seam and /loop stop). */
export function stopLoop(reason: string, options: { quiet?: boolean } = {}): boolean {
  return stopLoopOf(current(), reason, options);
}

// ----------------------------------------------------------------- skills

export async function listSkills(): Promise<
  Result<{ skills: SkillRow[]; claudeCodeMode: boolean; summary: string[] }>
> {
  const s = current();
  const set = await loadSkills({ includeClaudeSkills: s.claudeCodeMode });
  return {
    ok: true,
    value: {
      skills: set.skills.map((k) => ({
        name: k.name,
        description: k.description,
        source: k.source,
        enabled: k.enabled,
      })),
      claudeCodeMode: s.claudeCodeMode,
      summary: summarizeSkills(set),
    },
  };
}

/** Commits the checklist: whatever is not checked is the disabled set. */
export async function setSkillsEnabled(enabledNames: string[]): Promise<Result> {
  const s = current();
  const set = await loadSkills({ includeClaudeSkills: s.claudeCodeMode });
  const enabled = new Set(enabledNames);
  const disabled = new Set(
    set.skills.map((k) => k.name).filter((n) => !enabled.has(n))
  );
  // The one place skills state is written deliberately: the result is
  // surfaced, because silently not saving a choice the user just made is
  // worse than saying so.
  const result = await saveDisabledSkillNames(disabled);
  if (!result.ok) {
    noteLines(s, [
      `Could not save which skills are enabled: ${result.error}`,
      "  The change applies to this session only.",
    ]);
    return { ok: false, error: result.error };
  }
  noteLines(s, [
    `Skills: ${set.skills.length - disabled.size} of ${set.skills.length} enabled.`,
    ...(disabled.size > 0 ? [`  Off: ${[...disabled].sort().join(", ")}`] : []),
  ]);
  return { ok: true };
}

async function runSkills(s: Session, args: string): Promise<Result> {
  const query = args.trim();
  const set = await loadSkills({ includeClaudeSkills: s.claudeCodeMode });
  if (!query) {
    noteLines(s, ["Skills:", ...summarizeSkills(set)]);
    return { ok: true };
  }
  const lookup = resolveSkill(set, query);
  if (lookup.kind === "not-found") {
    const available = set.skills.map((k) => k.name);
    noteLines(s, [
      `No skill named "${query}".`,
      ...(available.length > 0
        ? [`Available: ${available.join(", ")}`]
        : ["No skills found - run /skills to see what was searched."]),
    ]);
    return { ok: true };
  }
  if (lookup.kind === "ambiguous") {
    noteLines(s, [
      `"${query}" matches more than one skill - be more specific:`,
      ...lookup.candidates.map((c) => `  ${c.name} (${c.source})`),
    ]);
    return { ok: true };
  }
  const skill = lookup.skill;
  // Deduped by name so repeating /skills <name> doesn't queue the body twice.
  s.pendingForcedSkills = [
    ...s.pendingForcedSkills.filter((k) => k.name !== skill.name),
    skill,
  ];
  noteLines(
    s,
    s.pendingForcedSkills.length === 1
      ? [
          `${skill.name} will be sent in full with your next message.`,
          `  ${skill.filePath} · ${formatFileSize(skill.body.length)}`,
        ]
      : [
          `Forcing ${s.pendingForcedSkills.length} skills into your next message: ${s.pendingForcedSkills
            .map((k) => k.name)
            .join(", ")}`,
        ]
  );
  stateChanged(s);
  return { ok: true };
}

// ------------------------------------------------------- /claude-code-mode

// The ONE place a session's claudeCodeMode is set. read_skill reads it through
// that session's ToolContext (areClaudeSkillsEnabled), not through the
// module-level singleton in skillStore.ts, which this app never writes.
function applyClaudeCodeMode(s: Session, on: boolean): void {
  s.claudeCodeMode = on;
  stateChanged(s);
}

async function toggleClaudeCodeMode(s: Session): Promise<Result> {
  if (s.claudeCodeMode) {
    applyClaudeCodeMode(s, false);
    s.claudeContext = null;
    s.pendingClaudePriming = false;
    noteLines(s, [
      "◊ Claude Code mode off - memories already sent stay in this conversation's history.",
      "  Run /new for a conversation without them.",
    ]);
    return { ok: true };
  }
  const context = await loadClaudeContext();
  const summary = summarizeContext(context);
  if (!hasAnyContext(context)) {
    noteLines(s, [
      "◊ Claude Code mode not enabled - no memories or instruction files found.",
      ...summary.map((line) => `  ${line}`),
    ]);
    return { ok: true };
  }
  s.claudeContext = context;
  s.pendingClaudePriming = true;
  applyClaudeCodeMode(s, true);
  noteLines(s, [
    "◊ Claude Code mode on - the agent will be primed with:",
    ...summary.map((line) => `  · ${line}`),
    "  Sent once, with your next message. It is not shown in the transcript.",
  ]);
  return { ok: true };
}

// -------------------------------------------------------------- attachments

const IMAGE_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function discardFilesOnlyConversation(s: Session): void {
  const id = s.filesOnlyConversationId;
  if (!id) {
    return;
  }
  s.filesOnlyConversationId = null;
  if (s.conversationId === id) {
    setConversation(s, null, null);
  }
  void deleteEmptyConversation(id).then(() => emit({ type: "conversations-changed" }));
}

async function deleteEmptyConversation(id: string): Promise<void> {
  const stub = testClient as unknown as { deleteConversation?: (id: string) => Promise<unknown> } | null;
  if (stub) {
    await stub.deleteConversation?.(id);
    return;
  }
  // Best effort: the public API has no delete; history.ts explains the
  // private endpoint's standing.
  await deleteConversationPrivate(id);
}

/** Drops the files-only conversation once nothing is left to send with it. */
function discardIfNothingAttached(s: Session): void {
  if (
    s.filesOnlyConversationId &&
    !s.attachments.some((a) => a.status === "ready" || a.status === "uploading")
  ) {
    discardFilesOnlyConversation(s);
  }
}

async function ensureConversationForFiles(
  s: Session,
  dust: DustAPI,
  title: string,
  uploadEpoch: number
): Promise<string> {
  if (s.conversationId) {
    return s.conversationId;
  }
  if (s.busy) {
    // The first message is creating the conversation right now; creating a
    // second one here would split the files from the message.
    throw new Error("The conversation is still being created. Attach it again in a moment.");
  }
  const res = await dust.createConversation({
    title,
    visibility: "unlisted",
    contentFragments: [],
  });
  if (res.isErr()) {
    throw new Error(`Failed to create conversation: ${res.error.message}`);
  }
  const created = res.value.conversation.sId;
  if (uploadEpoch !== s.epoch) {
    // The session was retired while this was being created: it must not
    // leave a stray conversation behind.
    void deleteEmptyConversation(created);
    throw new Error("Cancelled: the conversation changed.");
  }
  s.filesOnlyConversationId = created;
  setConversation(s, created, title);
  emit({ type: "conversations-changed" });
  return created;
}

function queueUpload(
  s: Session,
  entry: AttachmentInfo & { fileId?: string },
  read: () => Promise<Buffer>
): void {
  s.attachments = [...s.attachments, entry];
  stateChanged(s);
  const uploadEpoch = s.epoch;
  s.uploadChain = s.uploadChain.then(async () => {
    try {
      if (!s.attachments.includes(entry) || uploadEpoch !== s.epoch) {
        return; // removed, or the session was replaced, before its turn came
      }
      const data = await read();
      const dust = await currentClient();
      if (!dust) {
        throw new Error("Not signed in.");
      }
      const convId = await ensureConversationForFiles(
        s,
        dust,
        `File Upload: ${entry.name}`.slice(0, 50),
        uploadEpoch
      );
      const up = await dust.uploadFile({
        fileObject: new File([new Uint8Array(data)], entry.name, {
          type: entry.contentType,
        }),
        fileName: entry.name,
        // What was actually read, not the size seen when it was chosen.
        fileSize: data.length,
        contentType: entry.contentType as never,
        useCase: "conversation",
        useCaseMetadata: { conversationId: convId },
      });
      if (up.isErr()) {
        throw new Error(`Upload failed: ${up.error.message}`);
      }
      if (uploadEpoch !== s.epoch) {
        return; // uploaded into a session that was retired
      }
      entry.fileId = up.value.id;
      entry.size = data.length;
      entry.status = "ready";
    } catch (error) {
      entry.status = "error";
      entry.error = normalizeError(error).message;
    }
    if (uploadEpoch === s.epoch) {
      discardIfNothingAttached(s);
    }
    stateChanged(s);
  });
}

export async function attachPaths(paths: string[]): Promise<Result> {
  const s = current();
  for (const p of paths.slice(0, 20)) {
    if (typeof p !== "string" || !p) {
      continue;
    }
    const name = path.basename(p);
    try {
      // Paths only ever come from the OS file dialog, a real drop/paste (the
      // preload derives them from File objects) or the clipboard reader, all
      // absolute. Anything else is refused before it touches the disk.
      if (!path.isAbsolute(p) || p.includes("\0")) {
        throw new Error("Not an absolute file path.");
      }
      const infoRes = await validateAndGetFileInfo(p);
      if (infoRes.isErr()) {
        throw infoRes.error;
      }
      const info = infoRes.value;
      queueUpload(
        s,
        {
          id: newId(),
          name: info.name,
          size: info.size,
          contentType: info.type,
          isImage: isImageFile(info.extension),
          status: "uploading",
        },
        () => readFile(p)
      );
    } catch (error) {
      s.attachments = [
        ...s.attachments,
        {
          id: newId(),
          name,
          size: 0,
          contentType: "",
          isImage: false,
          status: "error",
          error: normalizeError(error).message,
        },
      ];
      stateChanged(s);
    }
  }
  return { ok: true };
}

export function attachImage(bytes: Uint8Array, mime: string): Result {
  const ext = IMAGE_MIME_EXT[mime];
  if (!ext) {
    return { ok: false, error: "Only png, jpeg, gif and webp images can be pasted." };
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_SIZE) {
    return {
      ok: false,
      error: `Image too large: ${formatFileSize(bytes.byteLength)}. Maximum size: ${formatFileSize(MAX_FILE_SIZE)}`,
    };
  }
  const buffer = Buffer.from(bytes);
  queueUpload(
    current(),
    {
      id: newId(),
      name: `pasted-image-${Date.now()}.${ext}`,
      size: buffer.length,
      contentType: getMimeType(`.${ext}`),
      isImage: true,
      status: "uploading",
    },
    async () => buffer
  );
  return { ok: true };
}

/**
 * Ctrl+V fallback when the paste event carried no usable data: the CLI's own
 * clipboard reader (utils/clipboardImage.ts) asks the OS for raw image data or
 * a copied file reference. Windows tested; macOS untested, as in the CLI.
 */
export async function attachClipboard(): Promise<Result<boolean>> {
  const found = await getClipboardImagePath();
  if (found.isErr()) {
    return { ok: false, error: found.error.message };
  }
  if (found.value) {
    await attachPaths([found.value]);
    return { ok: true, value: true };
  }
  return { ok: true, value: false };
}

export function removeAttachment(id: string): Result {
  const s = current();
  s.attachments = s.attachments.filter((a) => a.id !== id);
  discardIfNothingAttached(s);
  stateChanged(s);
  return { ok: true };
}

// ----------------------------------------------------------------- mentions

let mentionCache: { root: string; files: string[]; at: number } | null = null;
let mentionScan: { root: string; promise: Promise<string[]> } | null = null;
// Bounds for a folder that is not a project (a home directory, a drive root):
// the scan stops early instead of walking the whole disk.
const MENTION_SCAN_MAX_FILES = 50_000;
const MENTION_SCAN_MAX_MS = 4000;
// New files show up without a restart, unlike a once-per-process cache.
const MENTION_CACHE_TTL_MS = 60_000;

/** Flat project file list for "@" mentions (same globs as the CLI). */
export async function mentionFiles(): Promise<Result<string[]>> {
  const root = folder;
  if (!root) {
    return { ok: true, value: [] };
  }
  if (
    mentionCache &&
    mentionCache.root === root &&
    Date.now() - mentionCache.at < MENTION_CACHE_TTL_MS
  ) {
    return { ok: true, value: mentionCache.files };
  }
  // One scan at a time per folder: concurrent "@"s share it.
  if (!mentionScan || mentionScan.root !== root) {
    const promise = scanMentionFiles(root).finally(() => {
      if (mentionScan?.promise === promise) mentionScan = null;
    });
    mentionScan = { root, promise };
  }
  const files = await mentionScan.promise;
  mentionCache = { root, files, at: Date.now() };
  return { ok: true, value: files };
}

async function scanMentionFiles(root: string): Promise<string[]> {
  const started = Date.now();
  const matches: string[] = [];
  for await (const match of globIterate("**/*", {
    cwd: root,
    nodir: true,
    dot: false,
    ignore: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/coverage/**",
      // Beyond the CLI's list: build output and caches that make a mention
      // scan crawl on .NET / Python / Rust trees and are never worth mentioning.
      "**/bin/**",
      "**/obj/**",
      "**/target/**",
      "**/.venv/**",
      "**/__pycache__/**",
      "**/.vs/**",
    ],
  })) {
    matches.push(match);
    if (
      matches.length >= MENTION_SCAN_MAX_FILES ||
      Date.now() - started > MENTION_SCAN_MAX_MS
    ) {
      break;
    }
  }
  return matches
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, 2000);
}
