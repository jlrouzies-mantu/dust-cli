import { z } from "zod";

import {
  MEMORY_STORAGE_MODEL,
  getGlobalMemoryDir,
  getProjectMemoryDir,
  loadClaudeContext,
} from "../../utils/claudeMemory.js";
import { normalizeError } from "../../utils/errors.js";
import type { McpTool } from "../types/tools.js";

/**
 * Lets the agent look up Claude Code's memories on demand.
 *
 * Deliberately catalogue-first: with no arguments this lists names and
 * one-line descriptions rather than dumping every memory's contents. A user
 * who has been running Claude Code for months can have hundreds of
 * memories, and a tool whose cheapest call returns all of them invites
 * exactly the context blowout /claude-code-mode's priming block already
 * takes care to avoid (see MEMORY_INLINE_CHAR_BUDGET). Bodies come back only
 * for memories the agent names.
 */
export class ReadMemoryTool implements McpTool {
  name = "read_memory";

  description =
    "Looks up the user's Claude Code memories - durable notes kept on the user's local machine about " +
    "who they are, this project, and how they want to be worked with.\n\n" +
    `${MEMORY_STORAGE_MODEL}\n\n` +
    "Usage:\n" +
    "- No arguments: lists every memory as one line each (name, scope, type, summary). Cheap - start here.\n" +
    "- `names`: returns the full contents of just the memories you name. This is how you actually read one.\n" +
    "- `all: true`: returns every memory in full. Only for an explicit request to review or audit the " +
    "whole memory store - it can be very large, and reading everything to answer one question wastes " +
    "the context you need for the task.\n\n" +
    "A summary line is not the memory: do not rely on one as though you had read the file. " +
    "Memories reflect what was true when they were written, so verify anything you are about to rely on " +
    "that may have changed (a named file, function, or flag) before recommending it. " +
    "If the conversation already quoted a memory in full, you do not need to fetch it again.";

  inputSchema = z.object({
    names: z
      .array(z.string())
      .optional()
      .describe(
        "Slugs of the specific memories to read in full, exactly as listed in the catalogue (e.g. ['prefers-tabs']). Name only the ones plausibly relevant to the current task."
      ),
    all: z
      .boolean()
      .optional()
      .describe(
        "Return every memory in full instead of a catalogue. Expensive - leave unset unless the user explicitly asked to review the whole memory store."
      ),
  });

  async execute({ names, all }: z.infer<typeof this.inputSchema>) {
    try {
      const context = await loadClaudeContext();
      const where = `project: ${getProjectMemoryDir()}, global: ${getGlobalMemoryDir()}`;

      if (context.memories.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No memories found. Searched ${where}.`,
            },
          ],
        };
      }

      const render = (memory: (typeof context.memories)[number]) =>
        [
          `## ${memory.name} (${memory.type ?? "untyped"}, ${memory.scope})`,
          memory.description ? `Summary: ${memory.description}` : null,
          `File: ${memory.filePath}`,
          "",
          memory.body,
        ]
          .filter((line) => line !== null)
          .join("\n");

      if (names && names.length > 0) {
        const requested = new Set(names);
        const found = context.memories.filter((memory) =>
          requested.has(memory.name)
        );
        const missing = names.filter(
          (name) => !context.memories.some((memory) => memory.name === name)
        );

        const sections: string[] = [];
        if (found.length > 0) {
          sections.push(found.map(render).join("\n\n---\n\n"));
        }
        if (missing.length > 0) {
          // Named-but-absent is reported rather than silently omitted, so a
          // typo doesn't read as "that memory says nothing".
          sections.push(
            `No memory named: ${missing.join(", ")}. Searched ${where}.`
          );
        }
        return {
          content: [{ type: "text" as const, text: sections.join("\n\n") }],
        };
      }

      if (all) {
        return {
          content: [
            {
              type: "text" as const,
              text: context.memories.map(render).join("\n\n---\n\n"),
            },
          ],
        };
      }

      // Default: the catalogue. Same shape as the priming block's, so a
      // name copied from either one works in a follow-up call.
      const catalogue = context.memories
        .map(
          (memory) =>
            `- ${memory.name} (${memory.scope}${
              memory.type ? `, ${memory.type}` : ""
            }): ${memory.description ?? "(no description)"}`
        )
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${context.memories.length} memories. These are summaries, not the memories themselves - ` +
              `call read_memory again with names: [...] to read the ones you need.\n\n${catalogue}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error reading memories: ${normalizeError(error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
}
