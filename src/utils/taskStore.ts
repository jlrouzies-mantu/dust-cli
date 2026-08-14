import { promises as fs } from "fs";
import { homedir } from "os";
import path from "path";

const TASKS_DIR = path.join(homedir(), ".dust-cli", "tasks");

export interface Task {
  // A short, stable identifier the agent assigns and reuses across calls -
  // what makes a task's identity (and its dependencies) trackable across
  // turns, unlike the original todo_write list, which had no way to refer
  // to "the same" item twice.
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  // Ids (from the same submitted list) that must be `completed` before this
  // task may be `in_progress` - see findDependencyViolations.
  dependsOn?: string[];
}

/**
 * The conversation id tool calls should persist against.
 *
 * A module-level singleton for the same reason planMode.ts is one: todo_write
 * and read_tasks execute inside the MCP transport layer, which has no access
 * to React state, so Chat.tsx pushes the current conversation id in here via
 * an effect - the same pattern used to push the chat mode into planMode.ts.
 */
let activeConversationId: string | null = null;

export function setActiveConversationId(id: string | null): void {
  activeConversationId = id;
}

export function getActiveConversationId(): string | null {
  return activeConversationId;
}

function taskFilePath(conversationId: string): string {
  return path.join(TASKS_DIR, `${conversationId}.json`);
}

function isValidTask(value: unknown): value is Task {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    return false;
  }
  if (typeof candidate.content !== "string") {
    return false;
  }
  if (
    candidate.status !== "pending" &&
    candidate.status !== "in_progress" &&
    candidate.status !== "completed"
  ) {
    return false;
  }
  if (candidate.dependsOn !== undefined) {
    if (
      !Array.isArray(candidate.dependsOn) ||
      !candidate.dependsOn.every((dep) => typeof dep === "string")
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Persists the full task list for a conversation to
 * ~/.dust-cli/tasks/<conversationId>.json, so it survives a `--resume`.
 *
 * Same discipline as transcriptStore.ts/planStore.ts: this is a convenience,
 * not part of the live flow (the todoListEmitter-driven UI update already
 * happened), so a write failure here must never surface to the user or
 * interrupt the turn.
 */
export async function saveTasks(
  conversationId: string,
  tasks: Task[]
): Promise<void> {
  try {
    await fs.mkdir(TASKS_DIR, { recursive: true });
    await fs.writeFile(
      taskFilePath(conversationId),
      JSON.stringify(tasks, null, 2),
      "utf-8"
    );
  } catch {
    // Best-effort persistence only.
  }
}

/**
 * Loads the persisted task list for a conversation. Missing file (no tasks
 * yet) and unreadable/corrupt file both resolve to an empty list rather than
 * throwing - a resume must never fail because of this, and any entry that
 * doesn't match the expected shape is dropped individually rather than
 * invalidating the whole file, since it's hand-editable JSON on disk.
 */
export async function loadTasks(conversationId: string): Promise<Task[]> {
  try {
    const raw = await fs.readFile(taskFilePath(conversationId), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isValidTask);
  } catch {
    return [];
  }
}

export interface DependencyViolation {
  taskId: string;
  taskContent: string;
  missingDependencyId: string;
  // "unknown": the dependency id isn't in this submission at all (most
  // likely a typo). "incomplete": it exists but hasn't finished yet.
  reason: "unknown" | "incomplete";
}

/**
 * Checks every task being submitted as `in_progress` against its
 * `dependsOn` list, entirely within the submitted array - there is no
 * cross-call reference to a since-removed task, matching todo_write's
 * existing full-replace semantics.
 *
 * Validation only, as the plan requires: this never mutates a task's status
 * itself. It reports what would be invalid so todo_write can refuse the
 * whole submission with an actionable error instead of silently allowing -
 * or silently correcting - it.
 */
export function findDependencyViolations(tasks: Task[]): DependencyViolation[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const violations: DependencyViolation[] = [];

  for (const task of tasks) {
    if (task.status !== "in_progress" || !task.dependsOn?.length) {
      continue;
    }
    for (const depId of task.dependsOn) {
      const dep = byId.get(depId);
      if (!dep) {
        violations.push({
          taskId: task.id,
          taskContent: task.content,
          missingDependencyId: depId,
          reason: "unknown",
        });
      } else if (dep.status !== "completed") {
        violations.push({
          taskId: task.id,
          taskContent: task.content,
          missingDependencyId: depId,
          reason: "incomplete",
        });
      }
    }
  }

  return violations;
}

export function formatDependencyViolations(
  violations: DependencyViolation[]
): string {
  return violations
    .map((v) =>
      v.reason === "unknown"
        ? `"${v.taskContent}" (${v.taskId}) depends on "${v.missingDependencyId}", which isn't in this list - check for a typo.`
        : `"${v.taskContent}" (${v.taskId}) depends on "${v.missingDependencyId}", which isn't completed yet.`
    )
    .join("\n");
}

/**
 * Shared rendering for both todo_write's confirmation text and read_tasks -
 * one format, so a task looks the same however it was reached.
 */
export function formatTaskList(tasks: Task[]): string {
  if (tasks.length === 0) {
    return "(empty task list)";
  }
  return tasks
    .map((task) => {
      const marker =
        task.status === "completed"
          ? "[x]"
          : task.status === "in_progress"
            ? "[~]"
            : "[ ]";
      const deps = task.dependsOn?.length
        ? ` (depends on: ${task.dependsOn.join(", ")})`
        : "";
      return `${marker} ${task.id}: ${task.content}${deps}`;
    })
    .join("\n");
}
