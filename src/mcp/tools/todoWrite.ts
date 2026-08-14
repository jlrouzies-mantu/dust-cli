import { EventEmitter } from "events";
import { z } from "zod";

import type { Task } from "../../utils/taskStore.js";
import {
  findDependencyViolations,
  formatDependencyViolations,
  formatTaskList,
  getActiveConversationId,
  saveTasks,
} from "../../utils/taskStore.js";
import type { McpTool } from "../types/tools.js";

// TodoItem is the established name this tool's consumers (Chat.tsx,
// Conversation.tsx) already import - kept as an alias of taskStore's Task
// rather than renaming those imports, since the two are exactly the same
// shape and taskStore.ts is the type's actual owner.
export type TodoItem = Task;

// Bridges tool calls (which run inside the MCP transport layer) to the
// React UI (Chat.tsx), which has no other way to observe them live.
export const todoListEmitter = new EventEmitter();

export class TodoWriteTool implements McpTool {
  name = "todo_write";
  description =
    "Creates or updates a persistent, visible task checklist for the current conversation (similar to Claude Code's " +
    "TodoWrite tool). Call this to plan multi-step work and to mark items in_progress/completed as you go, so the " +
    "user can see your progress. Always pass the FULL list of tasks - this replaces the previous list, it does not " +
    "merge with it.\n\n" +
    "Each task needs a short, stable `id` (e.g. \"install-deps\") that you reuse across calls when updating that " +
    "same task - ids are what make a task's identity, and its dependencies, trackable across turns. Use `dependsOn` " +
    "to list the ids of tasks that must be `completed` before this one may be `in_progress`: the call is refused, " +
    "with nothing changed, if you try to start a task whose dependency isn't done yet, or that names a dependency " +
    "id not present in this same list.\n\n" +
    "The list is persisted for this conversation, so it survives across turns and a `--resume`. Call read_tasks to " +
    "see the current list without rewriting it.";

  inputSchema = z.object({
    todos: z
      .array(
        z.object({
          id: z
            .string()
            .min(1)
            .describe(
              "A short, stable identifier for this task (e.g. 'install-deps'). Reuse the same id across calls to update the same task, and reference it from another task's dependsOn."
            ),
          content: z.string().describe("Short description of the task"),
          status: z
            .enum(["pending", "in_progress", "completed"])
            .describe("Current status of this task"),
          dependsOn: z
            .array(z.string())
            .optional()
            .describe(
              "Ids, from this same list, of tasks that must be completed before this one may be in_progress."
            ),
        })
      )
      .describe("The full, current list of tasks - replaces the old list"),
  });

  async execute({ todos }: z.infer<typeof this.inputSchema>) {
    // Checked before anything is applied or persisted: an all-or-nothing
    // refusal keeps the submission atomic, the same way plan mode's tool
    // gate refuses a write outright rather than partially applying it.
    const violations = findDependencyViolations(todos);
    if (violations.length > 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Rejected - nothing was changed. ${violations.length} task${
                violations.length === 1 ? "" : "s"
              } can't start yet:\n${formatDependencyViolations(violations)}`,
          },
        ],
        isError: true,
      };
    }

    todoListEmitter.emit("update", todos);

    // Awaited, unlike transcriptStore's fire-and-forget writes: those exist
    // purely as a crash-safety net where losing a line to a race is an
    // acceptable, rare edge case. This list is the thing read_tasks and a
    // later --resume actually rely on being current, so "persisted" should
    // mean persisted by the time this call returns - not best-effort,
    // eventually. saveTasks already swallows its own errors internally, so
    // awaiting it can't turn a disk failure into a failed tool call.
    const conversationId = getActiveConversationId();
    if (conversationId) {
      await saveTasks(conversationId, todos);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Task list updated:\n${formatTaskList(todos)}`,
        },
      ],
    };
  }
}
