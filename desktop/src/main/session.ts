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
  setClaudeSkillsEnabled,
  summarizeSkills,
} from "../../../src/utils/skillStore";

import { useFileSystemServer } from "../../../src/mcp/servers/fsServer";
import { todoListEmitter } from "../../../src/mcp/tools/todoWrite";
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
  setPlanMode,
} from "../../../src/utils/planMode";
import { saveApprovedPlan } from "../../../src/utils/planStore";
import { retryResult } from "../../../src/utils/retry";
import {
  configureSandbox,
  describeSandbox,
  resolveInSandbox,
} from "../../../src/utils/sandbox";
import {
  formatTaskList,
  loadTasks,
  setActiveConversationId,
} from "../../../src/utils/taskStore";
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
  PlanChoice,
  Result,
  SessionState,
  SkillRow,
  TaskItem,
  TranscriptItem,
  Usage,
} from "../shared/ipc";
import { sessionExpired } from "./auth";
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
 * Module-level state is deliberate, for the reason AGENTS.md gives for
 * planMode.ts and taskStore.ts: the tools run in the MCP transport layer and
 * read those singletons, so this process owns the session and pushes state
 * into them. The call sites that must stay wired:
 *   - setPlanMode:              applyMode()           (every mode change), plus
 *                               doInit()/teardownSession(), which reset `mode`
 *                               to "normal" in the same breath
 *   - setActiveConversationId:  setConversation()     (new / resume / create /
 *                               sign-out)
 *   - configureSandbox:         setFolder()           (every folder change)
 *   - setClaudeSkillsEnabled:   applyClaudeCodeMode()
 *   - the fs MCP server:        ensureFsServer() / closeFsServer() (closed on
 *                               sign-out and before a new sign-in)
 * Missing one of them is a known bug class in this repo.
 */

type AgentConfiguration =
  GetAgentConfigurationsResponseType["agentConfigurations"][number];
type Conversation = CreateConversationResponseType["conversation"];

// ------------------------------------------------------------------ state

let me: MeResponseType["user"] | null = null;
let workspaceName: string | null = null;
let agents: AgentConfiguration[] = [];
let agentId: string | null = null;
let folder: string | null = null;
let branch: string | null = null;
let mode: ChatMode = "normal";
let modelOverride: (ModelChoice & { label: string }) | null = null;
let effort: Effort | null = null;
let conversationId: string | null = null;
let conversationTitle: string | null = null;
let busy = false;
let thinking = false;
let actionLabel: string | null = null;
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
let queue: QueuedMessage[] = [];
// Attachments shown in the composer (uploading or ready) for the next send.
let attachments: (AttachmentInfo & { fileId?: string })[] = [];
let pendingAgent: { name: string; detail: string | null } | null = null;
let loadingConversationId: string | null = null;
let compacting: string | null = null;
let btwStatus: string | null = null;
// Cursor for "Load earlier messages" (see history.ts); null = nothing older.
let earlierCursor: number | null = null;
let loadingEarlier = false;
const knownTitles = new Map<string, string>();
let loop: LoopState | null = null;
let loopTimer: ReturnType<typeof setInterval> | null = null;
// /claude-code-mode and /skills state. These mirror the refs Chat.tsx keeps;
// see the comments on the originals for why each exists.
let claudeCodeMode = false;
let claudeContext: ClaudeContext | null = null;
let pendingClaudePriming = false;
let pendingForcedSkills: Skill[] = [];
let lastSentSkillCatalogue: string | null = null;
let skillRevision = 0;
let tasks: TaskItem[] = [];
let usage: Usage = { context: null, credits: null };
let notice: string | null = null;

let fsServerId: string | null = null;
let fsPromise: Promise<void> | null = null;
let initPromise: Promise<void> | null = null;

// Bumped whenever the conversation on screen is replaced (new, open, sign-out).
// Work that started before (a turn, an upload, a compaction) compares its
// captured value before writing into the transcript or session, so a late
// result never lands in the conversation that replaced it.
let epoch = 0;

// Per-turn handles.
let controller: AbortController | null = null;
let activeClient: DustAPI | null = null;
let activeAgentMessageId: string | null = null;
let currentToolName = "tool";
// What the agent has said so far this turn (primes /btw mid-turn).
let inFlightText = "";

const approvals = new Map<
  string,
  { request: ApprovalRequest; resolve: (d: ApprovalDecision) => void }
>();
let planPending: {
  id: string;
  markdown: string;
  resolve: (d: PlanDecision) => void;
} | null = null;

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

// ------------------------------------------------------------------ state out

export function getState(): SessionState {
  return {
    version: CLI_VERSION,
    upstreamVersion: UPSTREAM_CLI_VERSION,
    workspaceName,
    userName: me?.fullName ?? null,
    agents: agents.map(toAgentInfo),
    agentId,
    folder,
    branch,
    mode,
    modelOverride: modelOverride
      ? { modelId: modelOverride.modelId, label: modelOverride.label }
      : null,
    effort,
    conversationId,
    conversationTitle,
    busy,
    thinking,
    actionLabel,
    queue: queue.map((q) => ({ id: q.id, text: q.text })),
    pendingAgent,
    loadingConversationId,
    compacting,
    btwStatus,
    loop: loop
      ? {
          intervalMs: loop.intervalMs,
          prompt: loop.prompt,
          runs: loop.runs,
          maxRuns: loop.maxRuns,
          skipped: loop.skipped,
          summary: describeLoop(loop),
        }
      : null,
    claudeCodeMode,
    forcedSkills: pendingForcedSkills.map((k) => k.name),
    attachments: attachments.map(({ fileId: _f, ...a }) => a),
    hasEarlier: earlierCursor !== null,
    loadingEarlier,
    tasks,
    usage,
    sandbox: describeSandbox(),
    notice,
  };
}

function emitState(): void {
  emit({ type: "state", state: getState() });
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

function selectedAgent(): AgentConfiguration | null {
  return agents.find((a) => a.sId === agentId) ?? null;
}

function appendItem(item: TranscriptItem): void {
  emit({ type: "append", item });
}
const append = appendItem;

function note(tone: "info" | "error", text: string): void {
  append({ kind: "note", id: newId(), tone, text });
}

// ------------------------------------------------------------------ init

todoListEmitter.on("update", (todos: TaskItem[]) => {
  tasks = todos;
  emitState();
});

/** Idempotent: loads user, agents, remembered folder and agent. */
export function initSession(): Promise<void> {
  if (!initPromise) {
    initPromise = doInit().catch((error) => {
      initPromise = null;
      notice = normalizeError(error).message;
      emitState();
    });
  }
  return initPromise;
}

/**
 * Stops everything tied to the current identity: the loop, the running turn
 * (server-side too, while the token still works), pending dialogs, queued
 * messages and attachments, the fs MCP server, and the singletons (plan mode
 * back to off together with `mode`, the conversation id). Called before a
 * sign-out clears the tokens, when a session is found expired, and before a
 * fresh sign-in starts a new session.
 */
export async function teardownSession(): Promise<void> {
  // Everything synchronous first, so a new session started right after this
  // call (resetSession -> initSession) can never be undone by our tail.
  epoch++;
  const client = busy ? activeClient : null;
  const convId = conversationId;
  const messageId = activeAgentMessageId;
  stopLoop("signed out", { quiet: true });
  queue = [];
  rejectAllPending();
  controller?.abort();
  discardFilesOnlyConversation();
  attachments = [];
  closeFsServer();
  resetConversationState();
  setConversation(null, null);
  earlierCursor = null;
  tasks = [];
  usage = { context: null, credits: null };
  // `mode` and the plan-mode singleton move together, always (AGENTS.md):
  // resetting only the singleton would show "plan" while writes are allowed.
  mode = "normal";
  setPlanMode(false);
  emitState();
  // Aborting the local stream alone would leave the agent running (and
  // spending credits) server-side; this has to happen before the tokens go.
  if (client && convId && messageId) {
    await client
      .cancelMessageGeneration({ conversationId: convId, messageIds: [messageId] })
      .catch(() => undefined);
  }
}

/** Forget everything tied to the previous sign-in. */
export function resetSession(): void {
  void teardownSession();
  initPromise = null;
  me = null;
  agents = [];
  agentId = null;
  workspaceName = null;
  modelOverride = null;
  effort = null;
  notice = null;
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
  agentId = (remembered ?? dustAgent ?? agents[0])?.sId ?? null;

  if (settings.workingDir && isDirectory(settings.workingDir)) {
    setFolder(settings.workingDir, false);
  }
  // Together, never one without the other (see teardownSession).
  mode = "normal";
  setPlanMode(false);
  void refreshUsage();
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

// ------------------------------------------------------------------ folder

export function setFolder(dir: string, persist = true): Result {
  if (busy) {
    return { ok: false, error: "Stop the current turn before changing folder." };
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
  void ensureFsServer();
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

// The fs server is registered against one identity (the DustAPI client and the
// workspace it captured). It does NOT need re-registering on a folder switch:
// every tool resolves paths at call time through the sandbox singleton and
// process.cwd(), both of which setFolder() updates. It DOES on a sign-out or a
// new sign-in: the old transport would otherwise keep polling for tool calls
// under the old identity. fsGeneration makes a registration that completes
// after it was superseded close itself instead of becoming current.
let fsGeneration = 0;
let fsClose: (() => Promise<void>) | null = null;

function closeFsServer(): void {
  fsGeneration++;
  const close = fsClose;
  fsClose = null;
  fsServerId = null;
  fsPromise = null;
  if (close) {
    void close().catch(() => undefined);
  }
}

// Smoke-test seam: lets the harness observe that a sign-out closes the server.
// Returns the real handle it displaced, which the harness must put back:
// dropping it leaves the real transport running untracked and makes the next
// ensureFsServer() register a second one.
export function setFsServerForTest(
  id: string | null,
  close: (() => Promise<void>) | null
): { id: string | null; close: (() => Promise<void>) | null } {
  const previous = { id: fsServerId, close: fsClose };
  fsServerId = id;
  fsClose = close;
  return previous;
}

function ensureFsServer(): Promise<void> {
  if (fsServerId || testClient) {
    return Promise.resolve();
  }
  if (!fsPromise) {
    const generation = fsGeneration;
    const current = () => generation === fsGeneration;
    const attempt = (async () => {
      const clientRes = await getDustClient();
      const dust = clientRes.isOk() ? clientRes.value : null;
      if (!dust || !current()) {
        if (current()) fsPromise = null;
        return;
      }
      const res = await useFileSystemServer(
        dust,
        (serverId) => {
          // A heartbeat re-registration of a superseded server must not
          // overwrite the current id.
          if (current()) {
            fsServerId = serverId;
          }
        },
        requestDiffApproval,
        undefined,
        requestPlanApproval,
        (close) => {
          if (current()) {
            fsClose = close;
          } else {
            void close().catch(() => undefined);
          }
        }
      );
      if (res.isErr() && current()) {
        notice = res.error.message;
        fsPromise = null;
        emitState();
      }
    })();
    fsPromise = attempt;
  }
  return fsPromise;
}

// ------------------------------------------------------------------ mode

function applyMode(next: ChatMode): void {
  if (mode === next) {
    return;
  }
  mode = next;
  // The single point where UI state becomes tool behaviour (planMode.ts).
  setPlanMode(next === "plan");
  emitState();
}

export function setMode(next: ChatMode): Result {
  applyMode(next);
  return { ok: true };
}

export function cycleMode(): Result {
  applyMode(nextChatMode(mode as CliChatMode) as ChatMode);
  return { ok: true };
}

// ------------------------------------------------------------------ approvals

function publishApprovals(): void {
  const first = approvals.values().next().value;
  emit({
    type: "approval",
    request: first ? first.request : null,
    pending: approvals.size,
  });
}

function ask(request: ApprovalRequest): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    approvals.set(request.id, { request, resolve });
    publishApprovals();
  });
}

export function resolveApproval(id: string, decision: ApprovalDecision): Result {
  const entry = approvals.get(id);
  if (!entry) {
    return { ok: false, error: "That approval is no longer pending." };
  }
  approvals.delete(id);
  entry.resolve(decision);
  publishApprovals();
  return { ok: true };
}

function rejectAllPending(): void {
  for (const [id, entry] of approvals) {
    approvals.delete(id);
    entry.resolve({ kind: "reject" });
  }
  publishApprovals();
  if (planPending) {
    const pending = planPending;
    planPending = null;
    pending.resolve({ kind: "reject" });
    // The card in the transcript must not stay "pending" with no way to act.
    emit({ type: "patch", id: pending.id, patch: { outcome: "rejected" } as never });
    emit({ type: "plan-clear" });
  }
}

async function requestDiffApproval(
  original: string,
  updated: string,
  filePath: string
): Promise<boolean> {
  // A tool call that arrives with no turn running (a stale action from a
  // cancelled or torn-down turn) has nobody to approve it: refuse it.
  if (!busy) {
    return false;
  }
  const diff = buildDiff(filePath, original, updated);
  const tool = currentToolName;

  if (mode === "auto") {
    append({ kind: "diff", id: newId(), tool, diff });
    return true;
  }

  const decision = await ask({
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
      queue.unshift({
        id: newId(),
        text: `About the edit to ${filePath} that I just rejected: ${text}`,
        files: [],
      });
      emitState();
    }
    return false;
  }
  if (decision.kind === "approve-all") {
    applyMode("auto");
  }
  append({ kind: "diff", id: newId(), tool, diff });
  return true;
}

async function requestPlanApproval(plan: string): Promise<PlanDecision> {
  if (!busy) {
    return { kind: "reject" };
  }
  // A second present_plan while one is pending replaces it; the first
  // caller must not be left waiting forever.
  if (planPending) {
    const previous = planPending;
    planPending = null;
    emit({ type: "patch", id: previous.id, patch: { outcome: "rejected" } as never });
    previous.resolve({ kind: "reject" });
  }
  const id = newId();
  append({ kind: "plan", id, markdown: plan, outcome: "pending" });
  emit({ type: "plan-request", id, markdown: plan });
  return new Promise<PlanDecision>((resolve) => {
    planPending = { id, markdown: plan, resolve };
  });
}

export async function resolvePlan(id: string, choice: PlanChoice): Promise<Result> {
  if (!planPending || planPending.id !== id) {
    return { ok: false, error: "That plan is no longer pending." };
  }
  const pending = planPending;
  planPending = null;

  const decision: PlanDecision =
    choice.kind === "approve"
      ? { kind: "approve", then: choice.then }
      : { kind: "reject", comment: choice.comment?.trim() || undefined };

  if (decision.kind === "approve") {
    // Leaving plan mode is the user's approval, here and nowhere else: the
    // agent cannot lift the restriction by calling present_plan itself.
    applyMode(decision.then === "auto" ? "auto" : "normal");
    await saveApprovedPlan(conversationId, pending.markdown);
  }
  emit({
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
  emit({ type: "plan-clear" });
  pending.resolve(decision);
  return { ok: true };
}

/** Dust's own tool-approval step (distinct from the diff dialog). */
async function handleToolApproval(
  event: AgentActionSpecificEvent
): Promise<boolean> {
  if (event.type !== "tool_approve_execution") {
    return false;
  }
  // In plan mode a blocked tool must reach the tool itself, whose refusal
  // explains plan mode and points at present_plan (see Chat.tsx).
  if (
    mode === "plan" &&
    (PLAN_MODE_BLOCKED_TOOLS as readonly string[]).includes(
      event.metadata.toolName
    )
  ) {
    return true;
  }
  // Auto mode approves every tool call whatever its stake, as in Chat.tsx.
  if (mode === "auto") {
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

  const decision = await ask({
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
let lastAccepted: { text: string; at: number } | null = null;

// A compaction makes the conversation busy exactly like a running turn does
// (AGENTS.md): every gate that asks "can a message go out now?" uses this.
function isConversationBusy(): boolean {
  return busy || compacting !== null;
}

export function send(text: string): Result {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: "Empty message." };
  }
  if (!folder) {
    return { ok: false, error: "Choose a working folder first." };
  }
  if (!selectedAgent()) {
    return { ok: false, error: "No agent selected." };
  }
  if (attachments.some((a) => a.status === "uploading")) {
    return { ok: false, error: "Wait for the attachments to finish uploading." };
  }
  if (loadingConversationId) {
    return { ok: false, error: "Wait for the conversation to finish opening." };
  }
  const now = Date.now();
  if (
    lastAccepted &&
    lastAccepted.text === trimmed &&
    now - lastAccepted.at < DUPLICATE_WINDOW_MS
  ) {
    // Never silent: the composer gives the text back with this message, so a
    // repeat the user really meant is one more Enter away (after the window).
    // Queue drains and loop ticks do not come through here.
    return {
      ok: false,
      error: "Not sent: the same message went out less than 2 seconds ago. Send it again to repeat it.",
    };
  }
  lastAccepted = { text: trimmed, at: now };

  // Failed uploads are dropped; ready ones travel with this message.
  const files: UploadedFile[] = attachments
    .filter((a) => a.status === "ready" && a.fileId)
    .map((a) => ({
      id: a.id,
      fileId: a.fileId as string,
      name: a.name,
      size: a.size,
      contentType: a.contentType,
      isImage: a.isImage,
    }));
  attachments = [];
  // A message is on its way into it, so the conversation the uploads created
  // is no longer a discard candidate (a /clear-files now must not delete it).
  filesOnlyConversationId = null;
  dispatch({ id: newId(), text: trimmed, files });
  return { ok: true };
}

function dispatch(message: QueuedMessage): void {
  if (isConversationBusy()) {
    queue.push(message);
    emitState();
    return;
  }
  void runTurn(message);
}

// Called whenever something that made the conversation busy ends (a turn, a
// compaction). Runs the next queued message, if any, synchronously so no
// other send can slip in between the shift and the turn marking itself busy.
function drainQueue(): void {
  if (isConversationBusy()) {
    return;
  }
  const next = queue.shift();
  if (next) {
    void runTurn(next);
  }
}

export function recallQueued(): Result<string | null> {
  // A loop tick is not the user's text to edit; leave those to /loop stop.
  let index = queue.length - 1;
  while (index >= 0 && queue[index].loop) {
    index--;
  }
  if (index < 0) {
    return { ok: true, value: null };
  }
  const [last] = queue.splice(index, 1);
  emitState();
  return { ok: true, value: last.text };
}

function setConversation(id: string | null, title: string | null): void {
  conversationId = id;
  conversationTitle = title;
  // Keeps todo_write / read_tasks persisting against the right conversation.
  setActiveConversationId(id);
}

function headerDetail(agent: AgentConfiguration): string | null {
  const model = modelOverride?.modelId ?? agent.model?.modelId ?? null;
  const parts = [model, effort].filter(Boolean) as string[];
  return parts.length ? parts.join(" · ") : null;
}

async function runTurn(message: QueuedMessage): Promise<void> {
  const text = message.text;
  const agent = selectedAgent();
  if (!agent || !me) {
    return;
  }
  // Shadow the transcript writers: once the conversation is replaced (only a
  // sign-out can do that mid-turn), this turn's late output is dropped.
  const turnEpoch = epoch;
  const append = (item: TranscriptItem) => {
    if (epoch === turnEpoch) appendItem(item);
  };
  const note = (tone: "info" | "error", line: string) =>
    append({ kind: "note", id: newId(), tone, text: line });
  busy = true;
  // Nothing is drawn for the agent until it has something to show: a header
  // with nothing under it is what produced tall empty blocks. Until then the
  // renderer shows one compact "thinking" row from this.
  pendingAgent = { name: agent.name, detail: headerDetail(agent) };
  let headerShown = false;
  const ensureHeader = () => {
    if (headerShown) {
      return;
    }
    headerShown = true;
    pendingAgent = null;
    append({
      kind: "agent-header",
      id: newId(),
      agentName: agent.name,
      detail: headerDetail(agent),
    });
    emitState();
  };
  thinking = false;
  actionLabel = null;
  notice = null;
  const turnController = new AbortController();
  controller = turnController;
  const signal = turnController.signal;
  activeAgentMessageId = null;
  emitState();

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
      emit({ type: "text-delta", id: blockId, text: pendingText });
      pendingText = "";
    }
  };
  const pushText = (s: string) => {
    ensureHeader();
    if (!blockId) {
      blockId = newId();
      append({ kind: "agent-text", id: blockId, text: "", streaming: true });
    }
    pendingText += s;
    streamed += s;
    inFlightText = streamed;
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
      emit({
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
    activeClient = dust;

    // File tools need the fs MCP server attached before the first message.
    await ensureFsServer();

    // Plan mode is restated on every message while it is on.
    let sentText =
      mode === "plan"
        ? `${planModePreamble()}\n\n${text}\n\n${planModeReminder()}`
        : text;

    // Local skills (see skillStore.ts and AGENTS.md): the catalogue is
    // re-read every send and only injected when it differs from the last one
    // sent; forced bodies from /skills <name> ride along once. Gated on the fs
    // MCP server being attached, since without it read_skill is not callable.
    const forcedSkillsThisTurn = pendingForcedSkills;
    let skillsBlockIncluded = false;
    let freshSkillCatalogue: string | null | undefined;
    if (fsServerId) {
      const skillSet = await loadSkills({ includeClaudeSkills: claudeCodeMode });
      freshSkillCatalogue = buildSkillCatalogue(skillSet);
      const block = buildSkillsBlock({
        catalogue:
          freshSkillCatalogue !== lastSentSkillCatalogue ? freshSkillCatalogue : null,
        inlined: forcedSkillsThisTurn,
        revision: skillRevision + 1,
      });
      if (block) {
        sentText = `${block}\n\n${sentText}`;
        skillsBlockIncluded = true;
      }
    } else if (forcedSkillsThisTurn.length > 0) {
      const block = buildSkillsBlock({
        catalogue: null,
        inlined: forcedSkillsThisTurn,
        revision: skillRevision + 1,
      });
      if (block) {
        sentText = `${block}\n\n${sentText}`;
        skillsBlockIncluded = true;
      }
    }

    // Claude Code mode's one-time priming. The latch is only cleared once
    // the API has accepted the message (below), so a failed send does not
    // lose the memories for the rest of the conversation.
    const primingThisMessage = pendingClaudePriming && claudeContext !== null;
    if (primingThisMessage && claudeContext) {
      sentText = `${buildPrimingBlock(claudeContext)}\n\n${sentText}`;
    }

    const modelSelection = buildModelSelection(
      modelOverride,
      effort,
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
      clientSideMCPServerIds: fsServerId ? [fsServerId] : null,
    };

    let conversation: Conversation;
    let userMessageId: string;

    if (!conversationId) {
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
      if (epoch !== turnEpoch) {
        throw new Error("Signed out.");
      }
      setConversation(conversation.sId, conversation.title ?? text.slice(0, 50));
      emit({ type: "conversations-changed" });
    } else {
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
      pendingClaudePriming = false;
    }
    if (skillsBlockIncluded) {
      skillRevision += 1;
    }
    if (freshSkillCatalogue !== undefined) {
      lastSentSkillCatalogue = freshSkillCatalogue;
    }
    pendingForcedSkills = [];
    emitState();

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

    for await (const event of streamRes.value.eventStream) {
      if (epoch !== turnEpoch) {
        break; // torn down (sign-out); teardownSession cancelled server-side
      }
      if (!activeAgentMessageId && "messageId" in event && event.messageId) {
        activeAgentMessageId = event.messageId;
      }

      if (event.type === "generation_tokens") {
        if (event.classification === "tokens") {
          if (thinking) {
            thinking = false;
            emitState();
          }
          pushText(event.text);
        } else if (event.classification === "chain_of_thought" && !thinking) {
          thinking = true;
          emitState();
        }
      } else if (event.type === "agent_error") {
        throw new Error(`Agent error: ${event.error.message}`);
      } else if (event.type === "user_message_error") {
        throw new Error(`User message error: ${event.error.message}`);
      } else if (event.type === "agent_generation_cancelled") {
        closeBlock();
        note("info", "Stopped.");
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
        thinking = false;
        const name = event.action.toolName;
        currentToolName = name;
        const startedAt = Date.now();
        toolStarts.set(event.action.sId, startedAt);
        actionLabel = event.action.displayLabels?.running ?? "Running a tool";
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
        emitState();
      } else if (event.type === "agent_action_success") {
        const started = toolStarts.get(event.action.sId);
        actionLabel = null;
        emit({
          type: "patch",
          id: event.action.sId,
          patch: {
            status: event.action.status === "errored" ? "error" : "ok",
            durationMs:
              event.action.executionDurationMs ??
              (started ? Date.now() - started : null),
          } as never,
        });
        emitState();
        // A completed tool call is a natural checkpoint for the numbers.
        if (Date.now() - lastUsageRefresh > 8000) {
          lastUsageRefresh = Date.now();
          void refreshUsage();
        }
      } else if (event.type === "tool_approve_execution") {
        const approved = await handleToolApproval(event);
        if (!approved) {
          emit({
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
    void refreshUsage();
  } catch (error) {
    closeBlock();
    if (epoch !== turnEpoch) {
      // Torn down mid-turn: nothing to report into a conversation that is gone.
    } else if (signal.aborted) {
      note("info", "Stopped.");
    } else {
      const recovered = streamed ? null : await tryRecover();
      if (recovered) {
        append({
          kind: "agent-text",
          id: newId(),
          text: recovered,
          streaming: false,
        });
      } else {
        const message = normalizeError(error).message;
        note(
          "error",
          conversationId
            ? `${message}\n\nConversation: ${conversationId}`
            : message
        );
        if (/token|unauthor|401|not signed in/i.test(message)) {
          void sessionExpired("Your session expired. Sign in again.");
        }
      }
    }
  } finally {
    if (cancelFallback) {
      clearTimeout(cancelFallback);
      cancelFallback = null;
    }
    // A torn-down turn can finish after a new session has started a turn of
    // its own; the per-turn globals then belong to that one.
    if (controller === turnController) {
      busy = false;
      thinking = false;
      actionLabel = null;
      pendingAgent = null;
      inFlightText = "";
      controller = null;
      activeClient = null;
      activeAgentMessageId = null;
      rejectAllPending();
      emitState();
      emit({ type: "conversations-changed" });
      // Anything typed while the agent was busy goes out now, in order.
      drainQueue();
    }
  }
}

// The @dust-tt/client SSE "done" sentinel can exhaust its reconnect budget
// even though the answer landed; check the server before reporting failure.
async function tryRecover(): Promise<string | null> {
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
let cancelFallback: ReturnType<typeof setTimeout> | null = null;

export async function cancel(): Promise<Result> {
  // Like Esc in the CLI, stopping also ends a running loop.
  stopLoop("stopped");
  if (!busy) {
    return { ok: true };
  }
  // Pending dialogs would otherwise hold the stream open forever.
  rejectAllPending();
  const turnController = controller;
  if (activeClient && conversationId && activeAgentMessageId) {
    actionLabel = "Stopping...";
    emitState();
    // A real server-side cancel: aborting the local stream alone would leave
    // the agent running (and spending credits) in the background.
    const res = await activeClient.cancelMessageGeneration({
      conversationId,
      messageIds: [activeAgentMessageId],
    });
    if (!res.isErr()) {
      if (!cancelFallback && turnController) {
        cancelFallback = setTimeout(() => {
          cancelFallback = null;
          if (controller === turnController) {
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

/**
 * Opens a past conversation. One load at a time: while one is in flight the
 * UI disables the other conversations, New chat and the composer, and a
 * second call is refused here as well (we chose "block", not "supersede").
 */
export async function loadConversation(id: string): Promise<Result> {
  if (busy) {
    return { ok: false, error: "Stop the current turn first." };
  }
  if (compacting) {
    return { ok: false, error: "Wait for the compaction to finish." };
  }
  if (loadingConversationId) {
    return { ok: false, error: "Another conversation is still opening." };
  }
  loadingConversationId = id;
  emitState();
  try {
    const t0 = performance.now();
    const agentName = selectedAgent()?.name ?? "dust";
    // Fast path: only the newest messages (history.ts explains why).
    const page = testClient ? null : await fetchHistoryPage(id, { limit: 30, agentName });
    let items: TranscriptItem[];
    let title: string | null;
    let t1 = performance.now();
    if (page) {
      items = page.items;
      title = knownTitles.get(id) ?? null;
      earlierCursor = page.hasMore ? page.cursor : null;
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
      earlierCursor = null;
    }
    const t2 = performance.now();
    const loadedTasks = await loadTasks(id);
    epoch++;
    discardFilesOnlyConversation();
    resetConversationState();
    setConversation(id, title);
    tasks = loadedTasks;
    usage = { ...usage, context: null };
    queue = [];
    attachments = [];
    emit({ type: "transcript-reset", items });
    // After the reset, so the note is visible in the conversation just opened.
    stopLoop("you opened another conversation");
    const t3 = performance.now();
    Object.assign(lastLoadTimings, {
      path: page ? 1 : 0,
      fetchAndParseMs: Math.round(t1 - t0),
      buildItemsMs: Math.round(t2 - t1),
      emitMs: Math.round(t3 - t2),
      items: items.length,
    });
    void refreshUsage();
    return { ok: true };
  } finally {
    loadingConversationId = null;
    emitState();
  }
}

/** Fetches the page of messages before the oldest one on screen. */
export async function loadEarlier(): Promise<Result> {
  const id = conversationId;
  if (!id || earlierCursor === null || loadingEarlier) {
    return { ok: true };
  }
  loadingEarlier = true;
  emitState();
  try {
    const page = await fetchHistoryPage(id, {
      limit: 30,
      beforeRank: earlierCursor,
      agentName: selectedAgent()?.name ?? "dust",
    });
    if (!page) {
      return { ok: false, error: "Could not load earlier messages." };
    }
    if (conversationId !== id) {
      return { ok: true }; // the user moved on; drop the stale page
    }
    earlierCursor = page.hasMore ? page.cursor : null;
    emit({ type: "transcript-prepend", items: page.items });
    return { ok: true };
  } finally {
    loadingEarlier = false;
    emitState();
  }
}

// Everything that belongs to the conversation being discarded and must not
// leak into the next one. Mirrors Chat.tsx's startNewConversation.
// Used for /new, for opening another conversation (which, unlike in the CLI,
// can happen mid-session here) and for sign-out.
function resetConversationState(loopReason?: string): void {
  // Memories the agent was primed with are gone with the old conversation, so
  // re-arm using the context already read (not a fresh disk read). An opened
  // conversation gets them too: it may never have been primed.
  if (claudeCodeMode && claudeContext) {
    pendingClaudePriming = true;
  }
  // The catalogue-freshness comparison starts over (an opened conversation may
  // never have received the catalogue); a forced skill was a one-off for the
  // discarded conversation and is dropped, not carried.
  lastSentSkillCatalogue = null;
  skillRevision = 0;
  pendingForcedSkills = [];
  attachments = [];
  // A loop is bound to the conversation it was started in: it must not
  // carry on posting into a different one.
  if (loopReason) {
    stopLoop(loopReason);
  }
}

export function newConversation(): Result {
  if (isConversationBusy() || loadingConversationId) {
    return { ok: false, error: "Wait for the current work to finish." };
  }
  epoch++;
  discardFilesOnlyConversation();
  setConversation(null, null);
  earlierCursor = null;
  tasks = [];
  queue = [];
  usage = { ...usage, context: null };
  resetConversationState("/new started a fresh conversation");
  emit({ type: "transcript-reset", items: [] });
  emitState();
  return { ok: true };
}

export function selectAgent(id: string, persist = true): Result {
  if (!agents.some((a) => a.sId === id)) {
    return { ok: false, error: "Unknown agent." };
  }
  agentId = id;
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
  const agentModelId = selectedAgent()?.model?.modelId ?? null;
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
  if (query === null) {
    modelOverride = null;
    emitState();
    return { ok: true };
  }
  const { models } = await catalogue();
  // resolveModel also accepts ids outside the list when a provider can be
  // inferred; the server is the only thing that can say a model is invalid.
  const choice = resolveModel(query, models);
  if (!choice) {
    return { ok: false, error: `Unknown model "${query}".` };
  }
  modelOverride = choice;
  emitState();
  return { ok: true };
}

export function setEffort(next: Effort | null): Result {
  const allowed = ["high", "medium", "light", "none"];
  if (next !== null && !allowed.includes(next)) {
    return { ok: false, error: "Unknown effort." };
  }
  effort = next;
  emitState();
  return { ok: true };
}

// ------------------------------------------------------------------ usage

async function refreshUsage(): Promise<void> {
  if (testClient) {
    return;
  }
  const forConversation = conversationId;
  const forEpoch = epoch;
  const [context, credits] = await Promise.all([
    forConversation ? getContextUsage(forConversation) : Promise.resolve(null),
    getConsumedCredits(),
  ]);
  if (forEpoch !== epoch || forConversation !== conversationId) {
    // The conversation changed (or the session was torn down) while this was
    // in flight: its context figure belongs to the old one. Dropped whole;
    // the next refresh brings the credits.
    return;
  }
  usage = {
    context: context
      ? {
          used: context.contextUsage,
          size: context.contextSize,
          modelId: context.modelId,
        }
      : usage.context,
    credits: credits
      ? { consumed: credits.consumed, limit: credits.limit }
      : usage.credits,
  };
  emitState();
}

// ------------------------------------------------------------------ commands
//
// The slash commands whose behaviour lives here (the rest are pure UI and are
// handled in the renderer: /help /switch /resume /model /effort /attach
// /plan /auto /new /clear /exit). Each is a port of the matching handler in
// src/ui/commands/Chat.tsx, reusing the shared modules and keeping the rules
// AGENTS.md states for them.

function noteLines(lines: string[]): void {
  note("info", lines.join("\n"));
}
const noteLinesNow = noteLines;

export async function runCommand(name: string, args: string): Promise<Result> {
  switch (name) {
    case "compact":
      return runCompact(args);
    case "btw":
      return runBtw(args);
    case "loop":
      return runLoop(args);
    case "skills":
      return runSkills(args);
    case "claude-code-mode":
      return toggleClaudeCodeMode();
    case "tasks":
      return runTasks();
    case "clear-files":
      attachments = [];
      discardIfNothingAttached();
      emitState();
      return { ok: true };
    default:
      return { ok: false, error: `Unknown command /${name}.` };
  }
}

async function runTasks(): Promise<Result> {
  if (!conversationId) {
    noteLines([
      "Tasks: none yet.",
      "  todo_write creates the list the first time the agent calls it.",
    ]);
    return { ok: true };
  }
  const list = await loadTasks(conversationId);
  noteLines(["Tasks:", ...formatTaskList(list).split("\n")]);
  return { ok: true };
}

// ---------------------------------------------------------------- /compact

function runCompact(args: string): Result {
  const id = conversationId;
  if (!id) {
    noteLines([
      "Nothing to compact - this conversation hasn't started yet.",
      "  Send a message first.",
    ]);
    return { ok: true };
  }
  if (compacting) {
    noteLines(["A compaction is already running - give it a moment."]);
    return { ok: true };
  }
  if (loadingConversationId) {
    noteLines(["A conversation is opening - run /compact once it has."]);
    return { ok: true };
  }
  if (busy) {
    noteLines([
      "The agent is still working - a turn has to finish before compacting.",
      "  Wait for it (or stop it), then run /compact again.",
    ]);
    return { ok: true };
  }
  // Marked busy before any await, so a message typed meanwhile queues
  // instead of racing the compaction server-side (the bug this shipped with
  // in the CLI: see AGENTS.md).
  compacting = "Compacting…";
  emitState();
  const compactEpoch = epoch;
  void (async () => {
    // A sign-out mid-compaction replaces the conversation; its outcome must
    // not be written into whatever comes next.
    const noteLines = (lines: string[]) => {
      if (epoch === compactEpoch) noteLinesNow(lines);
    };
    try {
      const query = args.trim() || undefined;
      const { models } = await catalogue();
      if (query && !resolveModel(query, models)) {
        noteLines([
          `Unknown model "${query}".`,
          "  /compact takes the same model ids /model does.",
        ]);
        return;
      }
      const before = await getContextUsage(id);
      const agent = selectedAgent();
      const chosen = resolveCompactionModel({
        query,
        override: modelOverride,
        conversationModel: before,
        agentModel: agent?.model
          ? { modelId: agent.model.modelId, providerId: agent.model.providerId }
          : null,
        catalogue: models,
      });
      if (!chosen) {
        noteLines([
          "No model to summarize with.",
          "  Compaction has to name a concrete provider/model pair. This agent",
          "  runs on an `auto` selector, which only resolves to one per message,",
          "  and the conversation hasn't run a turn yet for one to be read from.",
          "  Send a message first, or name one: /compact <model-id>.",
        ]);
        return;
      }
      compacting = `Compacting with ${chosen.label}…`;
      emitState();
      const started = await startCompaction({
        conversationId: id,
        model: { providerId: chosen.providerId, modelId: chosen.modelId },
      });
      if (!started.ok) {
        // The server's wording is shown verbatim: each 409 tells the user a
        // different thing to do.
        noteLines([
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
        noteLines([
          "Compaction is taking longer than expected - still running server-side.",
          "  The context figure will drop when it lands.",
        ]);
        return;
      }
      if (outcome.status === "failed") {
        noteLines([
          "Compaction failed server-side. Nothing was changed.",
          "  Long conversations may keep degrading; /new starts a fresh one.",
        ]);
        return;
      }
      const after = await getContextUsage(id);
      noteLines([
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
      void refreshUsage();
    } catch (error) {
      noteLines([`Compaction failed: ${normalizeError(error).message}`]);
    } finally {
      compacting = null;
      emitState();
      drainQueue();
    }
  })();
  return { ok: true };
}

// -------------------------------------------------------------------- /btw

function runBtw(args: string): Result {
  const question = args.trim();
  if (!question) {
    noteLines([
      "Usage: /btw <question>",
      "  Asks the agent a quick side question. The answer is shown here but",
      "  never added to the conversation, and it works while a turn is running.",
    ]);
    return { ok: true };
  }
  const agent = selectedAgent();
  if (!agent || !me) {
    noteLines(["/btw: no agent selected yet."]);
    return { ok: true };
  }
  if (btwStatus !== null) {
    noteLines(["A /btw question is already being answered - give it a moment."]);
    return { ok: true };
  }
  const modelSelection = buildModelSelection(
    modelOverride,
    effort,
    agent.model
      ? { modelId: agent.model.modelId, providerId: agent.model.providerId }
      : null
  );
  const user = { username: me.username, fullName: me.fullName, email: me.email };
  const id = newId();
  btwStatus = `btw: asking @${agent.name}…`;
  append({ kind: "btw", id, question, status: "pending", answer: "" });
  emitState();

  // Deliberately NOT part of isConversationBusy (utils/btw.ts): it runs in a
  // separate conversation, so it cannot race the main turn, and blocking the
  // queue on it would defeat asking mid-turn. Nothing is posted to the main
  // conversation.
  void (async () => {
    try {
      const result = await askBtw({
        question,
        agentId: agent.sId,
        mainConversationId: conversationId,
        inFlightAnswer: busy ? inFlightText : undefined,
        user,
        modelSelection,
      });
      emit({
        type: "patch",
        id,
        patch: (result.ok
          ? { status: "done", answer: result.answer || "(no answer)" }
          : { status: "error", answer: `/btw failed: ${result.message}` }) as never,
      });
    } catch (error) {
      emit({
        type: "patch",
        id,
        patch: { status: "error", answer: normalizeError(error).message } as never,
      });
    } finally {
      btwStatus = null;
      emitState();
    }
  })();
  return { ok: true };
}

// ------------------------------------------------------------------- /loop

function runLoop(args: string): Result {
  const parsed = parseLoopCommand(args);
  if (!parsed.ok) {
    noteLines([`↻ ${parsed.error}`]);
    return { ok: true };
  }
  const command = parsed.value;

  if (command.kind === "status") {
    noteLines(
      loop
        ? [
            `↻ Looping ${describeLoop(loop)}`,
            `  Prompt: ${loop.prompt}`,
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
    if (!stopLoop("cancelled")) {
      noteLines(["↻ No loop running."]);
    }
    return { ok: true };
  }
  if (loop) {
    noteLines([
      "↻ A loop is already running - /loop stop it first.",
      `  Currently: ${describeLoop(loop)}`,
    ]);
    return { ok: true };
  }
  if (!folder || !selectedAgent()) {
    noteLines(["↻ Choose a working folder (and an agent) before starting a loop."]);
    return { ok: true };
  }

  // The limits (30s floor, run ceiling) live in loopController.ts and are
  // enforced by parseLoopCommand: they exist to stop an unattended loop
  // spending a credit balance.
  loop = {
    id: `loop_${Date.now()}`,
    intervalMs: command.intervalMs,
    prompt: command.prompt,
    runs: 0,
    maxRuns: command.maxRuns,
    skipped: 0,
  };
  noteLines([
    `↻ Looping every ${formatInterval(command.intervalMs)}, up to ${command.maxRuns} runs.`,
    `  Prompt: ${command.prompt}`,
    "  Runs once now, then on the interval. Stop or /loop stop to cancel.",
  ]);
  loopTimer = setInterval(tickLoop, command.intervalMs);
  tickLoop();
  return { ok: true };
}

// A tick never starts a turn directly: it goes through dispatch() like any
// message, so it queues behind a running turn. A tick that fires while its
// predecessor is still unsent or running is skipped, not stacked.
function tickLoop(): void {
  const current = loop;
  if (!current) {
    return;
  }
  if (current.runs >= current.maxRuns) {
    stopLoop(`reached its ${current.maxRuns}-run limit`);
    return;
  }
  if (isConversationBusy() || loadingConversationId || queue.some((m) => m.loop)) {
    loop = { ...current, skipped: current.skipped + 1 };
    emitState();
    return;
  }
  loop = { ...current, runs: current.runs + 1 };
  dispatch({ id: newId(), text: current.prompt, files: [], loop: true });
  emitState();
}

export function stopLoop(reason: string, options: { quiet?: boolean } = {}): boolean {
  const current = loop;
  if (!current) {
    return false;
  }
  loop = null;
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  // Pending loop ticks go with it.
  queue = queue.filter((m) => !m.loop);
  if (options.quiet) {
    emitState();
    return true;
  }
  noteLines([
    `↻ Loop stopped - ${reason}.`,
    `  Ran ${current.runs} of ${current.maxRuns}${
      current.skipped > 0
        ? `, skipped ${current.skipped} tick${current.skipped === 1 ? "" : "s"} while the agent was busy`
        : ""
    }.`,
  ]);
  emitState();
  return true;
}

// ----------------------------------------------------------------- skills

export async function listSkills(): Promise<
  Result<{ skills: SkillRow[]; claudeCodeMode: boolean; summary: string[] }>
> {
  const set = await loadSkills({ includeClaudeSkills: claudeCodeMode });
  return {
    ok: true,
    value: {
      skills: set.skills.map((k) => ({
        name: k.name,
        description: k.description,
        source: k.source,
        enabled: k.enabled,
      })),
      claudeCodeMode,
      summary: summarizeSkills(set),
    },
  };
}

/** Commits the checklist: whatever is not checked is the disabled set. */
export async function setSkillsEnabled(enabledNames: string[]): Promise<Result> {
  const set = await loadSkills({ includeClaudeSkills: claudeCodeMode });
  const enabled = new Set(enabledNames);
  const disabled = new Set(
    set.skills.map((k) => k.name).filter((n) => !enabled.has(n))
  );
  // The one place skills state is written deliberately: the result is
  // surfaced, because silently not saving a choice the user just made is
  // worse than saying so.
  const result = await saveDisabledSkillNames(disabled);
  if (!result.ok) {
    noteLines([
      `Could not save which skills are enabled: ${result.error}`,
      "  The change applies to this session only.",
    ]);
    return { ok: false, error: result.error };
  }
  noteLines([
    `Skills: ${set.skills.length - disabled.size} of ${set.skills.length} enabled.`,
    ...(disabled.size > 0 ? [`  Off: ${[...disabled].sort().join(", ")}`] : []),
  ]);
  return { ok: true };
}

async function runSkills(args: string): Promise<Result> {
  const query = args.trim();
  const set = await loadSkills({ includeClaudeSkills: claudeCodeMode });
  if (!query) {
    noteLines(["Skills:", ...summarizeSkills(set)]);
    return { ok: true };
  }
  const lookup = resolveSkill(set, query);
  if (lookup.kind === "not-found") {
    const available = set.skills.map((k) => k.name);
    noteLines([
      `No skill named "${query}".`,
      ...(available.length > 0
        ? [`Available: ${available.join(", ")}`]
        : ["No skills found - run /skills to see what was searched."]),
    ]);
    return { ok: true };
  }
  if (lookup.kind === "ambiguous") {
    noteLines([
      `"${query}" matches more than one skill - be more specific:`,
      ...lookup.candidates.map((c) => `  ${c.name} (${c.source})`),
    ]);
    return { ok: true };
  }
  const skill = lookup.skill;
  // Deduped by name so repeating /skills <name> doesn't queue the body twice.
  pendingForcedSkills = [
    ...pendingForcedSkills.filter((k) => k.name !== skill.name),
    skill,
  ];
  noteLines(
    pendingForcedSkills.length === 1
      ? [
          `${skill.name} will be sent in full with your next message.`,
          `  ${skill.filePath} · ${formatFileSize(skill.body.length)}`,
        ]
      : [
          `Forcing ${pendingForcedSkills.length} skills into your next message: ${pendingForcedSkills
            .map((k) => k.name)
            .join(", ")}`,
        ]
  );
  emitState();
  return { ok: true };
}

// ------------------------------------------------------- /claude-code-mode

// The ONE place the skills singleton is set (areClaudeSkillsEnabled() is read
// by read_skill in the MCP layer; see AGENTS.md). Any new path that flips the
// mode must call this rather than setting the singleton itself.
function applyClaudeCodeMode(on: boolean): void {
  claudeCodeMode = on;
  setClaudeSkillsEnabled(on);
  emitState();
}

async function toggleClaudeCodeMode(): Promise<Result> {
  if (claudeCodeMode) {
    applyClaudeCodeMode(false);
    claudeContext = null;
    pendingClaudePriming = false;
    noteLines([
      "◊ Claude Code mode off - memories already sent stay in this conversation's history.",
      "  Run /new for a conversation without them.",
    ]);
    return { ok: true };
  }
  const context = await loadClaudeContext();
  const summary = summarizeContext(context);
  if (!hasAnyContext(context)) {
    noteLines([
      "◊ Claude Code mode not enabled - no memories or instruction files found.",
      ...summary.map((line) => `  ${line}`),
    ]);
    return { ok: true };
  }
  claudeContext = context;
  pendingClaudePriming = true;
  applyClaudeCodeMode(true);
  noteLines([
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

// Uploads run one at a time: the first may have to create the (empty)
// conversation the files belong to, as the CLI does, and two uploads racing
// would create two.
let uploadChain: Promise<void> = Promise.resolve();

// The conversation the first upload had to create (as the CLI does: an upload
// needs a conversation id), until a message is posted into it. Until then it
// is empty, and it is deleted rather than left behind in the user's history
// if every upload fails, the chips are all removed, or the user moves on.
let filesOnlyConversationId: string | null = null;

function discardFilesOnlyConversation(): void {
  const id = filesOnlyConversationId;
  if (!id) {
    return;
  }
  filesOnlyConversationId = null;
  if (conversationId === id) {
    setConversation(null, null);
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
function discardIfNothingAttached(): void {
  if (
    filesOnlyConversationId &&
    !attachments.some((a) => a.status === "ready" || a.status === "uploading")
  ) {
    discardFilesOnlyConversation();
  }
}

async function ensureConversationForFiles(
  dust: DustAPI,
  title: string,
  uploadEpoch: number
): Promise<string> {
  if (conversationId) {
    return conversationId;
  }
  if (busy) {
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
  if (uploadEpoch !== epoch) {
    // The user started a new chat or opened another conversation while this
    // was being created: it must not hijack the one now on screen.
    void deleteEmptyConversation(created);
    throw new Error("Cancelled: the conversation changed.");
  }
  filesOnlyConversationId = created;
  setConversation(created, title);
  emit({ type: "conversations-changed" });
  return created;
}

function queueUpload(
  entry: AttachmentInfo & { fileId?: string },
  read: () => Promise<Buffer>
): void {
  attachments = [...attachments, entry];
  emitState();
  const uploadEpoch = epoch;
  uploadChain = uploadChain.then(async () => {
    try {
      if (!attachments.includes(entry) || uploadEpoch !== epoch) {
        return; // removed, or the conversation changed, before its turn came
      }
      const data = await read();
      const dust = await currentClient();
      if (!dust) {
        throw new Error("Not signed in.");
      }
      const convId = await ensureConversationForFiles(
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
      if (uploadEpoch !== epoch) {
        return; // uploaded into a conversation the user has left
      }
      entry.fileId = up.value.id;
      entry.size = data.length;
      entry.status = "ready";
    } catch (error) {
      entry.status = "error";
      entry.error = normalizeError(error).message;
    }
    if (uploadEpoch === epoch) {
      discardIfNothingAttached();
    }
    emitState();
  });
}

export async function attachPaths(paths: string[]): Promise<Result> {
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
      attachments = [
        ...attachments,
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
      emitState();
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
  attachments = attachments.filter((a) => a.id !== id);
  discardIfNothingAttached();
  emitState();
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
