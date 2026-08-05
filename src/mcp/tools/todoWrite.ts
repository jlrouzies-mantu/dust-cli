import { EventEmitter } from "events";
import { z } from "zod";

import type { McpTool } from "../types/tools.js";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

// Bridges tool calls (which run inside the MCP transport layer) to the
// React UI (Chat.tsx), which has no other way to observe them live.
export const todoListEmitter = new EventEmitter();

function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return "(empty todo list)";
  }
  return todos
    .map((todo) => {
      const marker =
        todo.status === "completed"
          ? "[x]"
          : todo.status === "in_progress"
            ? "[~]"
            : "[ ]";
      return `${marker} ${todo.content}`;
    })
    .join("\n");
}

export class TodoWriteTool implements McpTool {
  name = "todo_write";
  description =
    "Creates or updates a persistent, visible task checklist for the current session (similar to Claude Code's TodoWrite tool). " +
    "Call this to plan multi-step work and to mark items in_progress/completed as you go, so the user can see your progress. " +
    "Always pass the FULL list of todos - this replaces the previous list, it does not merge with it.";

  inputSchema = z.object({
    todos: z
      .array(
        z.object({
          content: z.string().describe("Short description of the task"),
          status: z
            .enum(["pending", "in_progress", "completed"])
            .describe("Current status of this task"),
        })
      )
      .describe("The full, current list of todos - replaces the old list"),
  });

  async execute({ todos }: z.infer<typeof this.inputSchema>) {
    todoListEmitter.emit("update", todos);

    return {
      content: [
        {
          type: "text" as const,
          text: `Todo list updated:\n${formatTodoList(todos)}`,
        },
      ],
    };
  }
}
