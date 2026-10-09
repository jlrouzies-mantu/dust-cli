/**
 * Types shared by main, preload and renderer. Types only: nothing here may
 * import Node or Electron, because the renderer bundles it too.
 *
 * What crosses the bridge is deliberately plain data. Tokens never do; the
 * sign-in flow exposes only the user code and the verification URLs.
 */

export type ChatMode = "normal" | "auto" | "plan";
export type Effort = "high" | "medium" | "light" | "none";

// ---------------------------------------------------------------- auth

export interface WorkspaceChoice {
  sId: string;
  name: string;
  role: string;
}

export type AuthStatus =
  | { kind: "checking" }
  | { kind: "signed-out"; reason?: string }
  | {
      kind: "signing-in";
      userCode: string;
      verificationUri: string;
      /** Epoch ms. */
      expiresAt: number;
      phase: "waiting" | "slow" | "saving";
    }
  | { kind: "choose-workspace"; workspaces: WorkspaceChoice[] }
  | { kind: "error"; message: string }
  | { kind: "ready" };

// ---------------------------------------------------------------- data

export interface AgentInfo {
  sId: string;
  name: string;
  description: string;
  model: { modelId: string; providerId: string } | null;
}

export interface TaskItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  dependsOn?: string[];
}

export interface ConversationSummary {
  sId: string;
  title: string;
  /** Epoch ms of last activity. */
  updated: number;
}

export interface ModelRow {
  modelId: string;
  providerId: string;
  label: string;
  contextSize: number | null;
  /** "legacy" | "degraded" | "current" | "override" ... */
  tags: string[];
}

export interface ModelList {
  source: "live" | "fallback";
  models: ModelRow[];
  agentModelId: string | null;
}

export interface Usage {
  context: { used: number; size: number; modelId: string | null } | null;
  credits: { consumed: number; limit: number | null } | null;
}

export interface SessionState {
  version: string;
  upstreamVersion: string;
  workspaceName: string | null;
  userName: string | null;
  agents: AgentInfo[];
  agentId: string | null;
  folder: string | null;
  branch: string | null;
  mode: ChatMode;
  modelOverride: { modelId: string; label: string } | null;
  effort: Effort | null;
  conversationId: string | null;
  conversationTitle: string | null;
  busy: boolean;
  thinking: boolean;
  /** "Running a tool" style label from the stream, if any. */
  actionLabel: string | null;
  queue: { id: string; text: string }[];
  tasks: TaskItem[];
  usage: Usage;
  sandbox: string;
  /** Non-fatal, user-facing problem (for example "file tools need OAuth"). */
  notice: string | null;
  /** Set while a turn has started but nothing has been shown for it yet. */
  pendingAgent: { name: string; detail: string | null } | null;
  /** Id of the conversation currently being opened, if any. */
  loadingConversationId: string | null;
  /** "Compacting..." style text while a /compact runs (the conversation is busy). */
  compacting: string | null;
  /** "btw: asking ..." while a side question is being answered. */
  btwStatus: string | null;
  loop: LoopInfo | null;
  claudeCodeMode: boolean;
  /** Skills queued by /skills <name> for the next message. */
  forcedSkills: string[];
  attachments: AttachmentInfo[];
  /** Older messages exist that were not loaded when the conversation opened. */
  hasEarlier: boolean;
  loadingEarlier: boolean;
}

export interface LoopInfo {
  intervalMs: number;
  prompt: string;
  runs: number;
  maxRuns: number;
  skipped: number;
  /** describeLoop() text, so the renderer need not re-derive it. */
  summary: string;
}

export interface AttachmentInfo {
  id: string;
  name: string;
  size: number;
  contentType: string;
  isImage: boolean;
  status: "uploading" | "ready" | "error";
  error?: string;
}

export interface SkillRow {
  name: string;
  description: string | null;
  source: string;
  enabled: boolean;
}

// ---------------------------------------------------------- transcript

export type DiffLine =
  | { t: "ctx" | "add" | "del"; no: number; text: string }
  | { t: "gap"; hidden: number };

export interface DiffPayload {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
  /** True when the line list was cut to keep the message small. */
  truncated: boolean;
}

export type TranscriptItem =
  | { kind: "user"; id: string; text: string; attachments?: string[] }
  | {
      kind: "agent-header";
      id: string;
      agentName: string;
      detail: string | null;
    }
  | { kind: "agent-text"; id: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      detail: string;
      status: "running" | "ok" | "error" | "rejected";
      /** Epoch ms, for the running row's elapsed time. */
      startedAt: number;
      durationMs: number | null;
    }
  | { kind: "diff"; id: string; tool: string; diff: DiffPayload }
  | {
      kind: "plan";
      id: string;
      markdown: string;
      outcome: "pending" | "approved-auto" | "approved-wait" | "rejected";
      comment?: string;
    }
  | { kind: "note"; id: string; tone: "info" | "error"; text: string }
  | {
      kind: "btw";
      id: string;
      question: string;
      status: "pending" | "done" | "error";
      answer: string;
    };

// ----------------------------------------------------------- approvals

export type ApprovalRequest =
  | {
      id: string;
      type: "edit";
      tool: string;
      diff: DiffPayload;
      insideSandbox: boolean;
      sandbox: string;
    }
  | {
      id: string;
      type: "tool";
      tool: string;
      stake: string;
      inputs: string;
      canRemember: boolean;
    };

export type ApprovalDecision =
  | { kind: "approve" }
  | { kind: "approve-all" }
  | { kind: "approve-remember" }
  | { kind: "reject"; note?: string };

export type PlanChoice =
  | { kind: "approve"; then: "auto" | "wait" }
  | { kind: "reject"; comment?: string };

// -------------------------------------------------------------- events

export type SessionEvent =
  | { type: "auth"; status: AuthStatus }
  | { type: "state"; state: SessionState }
  | { type: "transcript-reset"; items: TranscriptItem[] }
  | { type: "transcript-prepend"; items: TranscriptItem[] }
  | { type: "append"; item: TranscriptItem }
  | { type: "text-delta"; id: string; text: string }
  | { type: "patch"; id: string; patch: Partial<TranscriptItem> }
  | { type: "approval"; request: ApprovalRequest | null; pending: number }
  | { type: "plan-request"; id: string; markdown: string }
  | { type: "plan-clear" }
  | { type: "conversations-changed" };

// ----------------------------------------------------------------- API

export interface Result<T = void> {
  ok: boolean;
  error?: string;
  value?: T;
}

export interface DustmApi {
  /** Current auth status plus, when ready, the full session state. */
  bootstrap(): Promise<{ auth: AuthStatus; state: SessionState | null }>;

  auth: {
    start(): Promise<Result>;
    cancel(): Promise<Result>;
    openBrowser(): Promise<Result>;
    copyCode(): Promise<Result>;
    selectWorkspace(id: string): Promise<Result>;
    signOut(): Promise<Result>;
  };

  chooseFolder(): Promise<Result<string | null>>;
  listConversations(): Promise<Result<ConversationSummary[]>>;
  loadConversation(id: string): Promise<Result>;
  newConversation(): Promise<Result>;
  loadEarlier(): Promise<Result>;
  selectAgent(id: string): Promise<Result>;

  send(text: string): Promise<Result>;
  cancel(): Promise<Result>;
  recallQueued(): Promise<Result<string | null>>;

  setMode(mode: ChatMode): Promise<Result>;
  cycleMode(): Promise<Result>;

  listModels(): Promise<Result<ModelList>>;
  setModel(modelId: string | null): Promise<Result>;
  setEffort(effort: Effort | null): Promise<Result>;

  resolveApproval(id: string, decision: ApprovalDecision): Promise<Result>;
  resolvePlan(id: string, choice: PlanChoice): Promise<Result>;

  openExternal(url: string): Promise<Result>;

  /** Slash commands whose logic lives in main (see session.runCommand). */
  runCommand(name: string, args: string): Promise<Result>;
  quit(): Promise<Result>;
  mentionFiles(): Promise<Result<string[]>>;
  skills: {
    list(): Promise<Result<{ skills: SkillRow[]; claudeCodeMode: boolean; summary: string[] }>>;
    setEnabled(enabledNames: string[]): Promise<Result>;
  };
  attach: {
    pickFiles(): Promise<Result>;
    /**
     * Dropped or pasted File objects. The preload turns them into paths
     * (Electron webUtils) itself, so page script can only ever attach a file
     * the user actually dropped or pasted, never a path it made up. Returns
     * how many had no path (an image dragged out of a browser, say), which
     * the caller can send as bytes instead.
     */
    files(files: readonly File[]): Promise<Result<number>>;
    image(bytes: Uint8Array, mime: string): Promise<Result>;
    clipboard(): Promise<Result<boolean>>;
    remove(id: string): Promise<Result>;
  };
  /** True when a dropped/pasted File has a path on disk (Electron webUtils). */
  hasPath(file: File): boolean;

  /** Subscribes to session events. Returns an unsubscribe function. */
  onEvent(listener: (event: SessionEvent) => void): () => void;
}

declare global {
  interface Window {
    dustm: DustmApi;
  }
}
