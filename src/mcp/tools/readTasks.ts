import { z } from "zod";

import { normalizeError } from "../../utils/errors.js";
import {
  formatTaskList,
  getActiveConversationId,
  loadTasks,
} from "../../utils/taskStore.js";
import type { McpTool } from "../types/tools.js";

/**
 * Lets the agent check the task list without rewriting it.
 *
 * todo_write always replaces the full list, so reading it back that way
 * would mean resubmitting every task just to look - and risks accidentally
 * dropping one. This is the read-only counterpart, and the seam a delegated
 * helper agent would use to see what's already claimed or completed before
 * picking up work of its own, without needing write access to the list.
 */
export class ReadTasksTool implements McpTool {
  name = "read_tasks";

  description =
    "Reads the current task checklist for this conversation, without rewriting it. Use this to check status, " +
    "confirm what's already completed, or see which tasks are still blocked on a dependency before deciding what " +
    "to work on next. Takes no arguments.";

  inputSchema = z.object({});

  async execute() {
    try {
      const conversationId = getActiveConversationId();
      if (!conversationId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No active conversation yet - there is nothing to read.",
            },
          ],
        };
      }

      const tasks = await loadTasks(conversationId);
      return {
        content: [{ type: "text" as const, text: formatTaskList(tasks) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error reading tasks: ${normalizeError(error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
}
