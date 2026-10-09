import type { Task } from "../utils/taskStore.js";

/**
 * Per-server answers to "what is true for the conversation calling this tool?".
 *
 * The CLI never passes one: it has exactly one conversation, so the tools fall
 * back to the module-level singletons (planMode.ts, taskStore.ts's active
 * conversation id, skillStore.ts's Claude-skills flag) and behave exactly as
 * before.
 *
 * A front end that runs several conversations at once (the desktop app) cannot
 * use singletons: one global "plan mode" would apply to every parallel turn. It
 * registers one fs MCP server *per conversation* - Dust routes a tool call to
 * the server ids listed in that message's `clientSideMCPServerIds`, so the
 * server a call arrives on identifies its conversation by construction - and
 * hands each server's tools a context bound to that conversation's state.
 */
export interface ToolContext {
  isPlanMode(): boolean;
  getConversationId(): string | null;
  areClaudeSkillsEnabled(): boolean;
  /** Replaces the global todoListEmitter for this server's todo_write. */
  onTasksUpdated?(tasks: Task[]): void;
}
