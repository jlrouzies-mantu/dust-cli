import fs from "fs/promises";
import path from "path";
import { z } from "zod";

import type { MemoryScope, MemoryType } from "../../utils/claudeMemory.js";
import {
  MEMORY_STORAGE_MODEL,
  MEMORY_TYPES,
  getMemoryDirForScope,
  isValidMemoryName,
  serializeMemoryFile,
} from "../../utils/claudeMemory.js";
import { normalizeError } from "../../utils/errors.js";
import type { McpTool } from "../types/tools.js";

const MEMORY_INDEX_FILENAME = "MEMORY.md";

/**
 * Rewrites MEMORY.md - the one-line-per-memory index Claude Code loads at
 * the start of every session to decide which memories are worth pulling in.
 * A memory the index doesn't mention is effectively invisible to it, so the
 * index has to be kept in step with every write and delete.
 *
 * Matching is on the `](<name>.md)` link target rather than the visible
 * title, since the title is free text a later write may legitimately change
 * while still pointing at the same file.
 */
async function updateMemoryIndex(
  memoryDir: string,
  name: string,
  entry: string | null
): Promise<void> {
  const indexPath = path.join(memoryDir, MEMORY_INDEX_FILENAME);

  let existing = "";
  try {
    existing = await fs.readFile(indexPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const linkTarget = `](${name}.md)`;
  const lines = existing.split(/\r?\n/);
  const kept = lines.filter(
    (line) => !(line.trimStart().startsWith("- ") && line.includes(linkTarget))
  );

  if (entry) {
    // Keep the pointer list contiguous: insert after the last existing
    // pointer rather than at the very end, which could otherwise fall below
    // trailing blank lines or a closing note.
    let lastPointer = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i].trimStart().startsWith("- [")) {
        lastPointer = i;
        break;
      }
    }
    if (lastPointer >= 0) {
      kept.splice(lastPointer + 1, 0, entry);
    } else {
      // No pointers yet - drop trailing blanks, then append.
      while (kept.length > 0 && kept[kept.length - 1].trim() === "") {
        kept.pop();
      }
      kept.push(entry);
    }
  }

  const content = `${kept.join("\n").replace(/\n+$/, "")}\n`;
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(indexPath, content, "utf-8");
}

export class WriteMemoryTool implements McpTool {
  name = "write_memory";

  private diffApprovalCallback?: (
    originalContent: string,
    updatedContent: string,
    filePath: string
  ) => Promise<boolean>;

  description =
    "Creates, updates, or deletes one of the user's Claude Code memories - a durable note stored on " +
    "the user's local machine that both this CLI and Claude Code itself read back in later sessions.\n\n" +
    `${MEMORY_STORAGE_MODEL}\n\n` +
    "Because scope is keyed on the working directory, choosing it wrong makes a memory either invisible " +
    "where it is needed or noise everywhere else. Use `scope: \"project\"` for facts about this codebase " +
    "(its architecture decisions, its constraints, its ongoing work). Use `scope: \"global\"` for facts " +
    "about the user themselves, which should follow them into every project. If a fact would still be " +
    "true in a different repository, it is global.\n\n" +
    "Write one when you learn something durable: who the user is and how they prefer to work " +
    "(`user`), guidance they have given you including the reason for it (`feedback`), ongoing work, " +
    "goals or constraints that are not derivable from the code or git history (`project`), or a " +
    "pointer to an external resource such as a URL, dashboard, or ticket (`reference`).\n\n" +
    "Do NOT write a memory for: anything the repository already records (code structure, past fixes, " +
    "git history, CLAUDE.md); anything that only matters to the current conversation; or anything true " +
    "only on the current git branch, since every branch shares one memory set. " +
    "One memory holds one fact - do not batch several unrelated facts into a single memory. " +
    "Convert relative dates ('last week') to absolute ones before storing them. " +
    "Before creating a memory, call read_memory (with no arguments, for the cheap catalogue) to check " +
    "whether one already covers the same ground - update that one instead of adding a near-duplicate. " +
    "Every memory you add is context cost in every future session, so prefer updating over accumulating. " +
    "The user is shown a preview and must approve every write.";

  inputSchema = z.object({
    name: z
      .string()
      .describe(
        "Short kebab-case slug identifying this memory, also used as its filename and as the [[link]] target from other memories (e.g. 'prefers-npm-over-yarn'). Lowercase letters, digits and dashes only."
      ),
    action: z
      .enum(["write", "delete"])
      .default("write")
      .describe(
        "'write' creates the memory or replaces it entirely if it already exists; 'delete' removes it (use when a memory turns out to be wrong)."
      ),
    description: z
      .string()
      .optional()
      .describe(
        "One-line summary of the fact, used to judge relevance when recalling memories later. Required for 'write'."
      ),
    type: z
      .enum(MEMORY_TYPES)
      .optional()
      .describe(
        "'user' = who the user is; 'feedback' = guidance on how you should work; 'project' = ongoing work, goals or constraints; 'reference' = pointer to an external resource. Required for 'write'."
      ),
    content: z
      .string()
      .optional()
      .describe(
        "The fact itself, in full. For 'feedback' and 'project', follow it with '**Why:**' and '**How to apply:**' lines. Link related memories with [[their-slug]]. Required for 'write'."
      ),
    scope: z
      .enum(["project", "global"])
      .default("project")
      .describe(
        "'project' stores the memory against the current working directory (the default, and correct for anything specific to this codebase - note it will NOT be visible from a different checkout or from a subdirectory); 'global' stores it user-level, so it is recalled in every project. If the fact would still be true in another repository, use 'global'."
      ),
  });

  setDiffApprovalCallback(
    callback: (
      originalContent: string,
      updatedContent: string,
      filePath: string
    ) => Promise<boolean>
  ) {
    this.diffApprovalCallback = callback;
  }

  async execute({
    name,
    action,
    description,
    type,
    content,
    scope,
  }: z.infer<typeof this.inputSchema>) {
    try {
      // A memory name becomes a filename, so anything outside the slug
      // pattern is rejected outright - that also means a name can never
      // traverse out of the memory directory.
      if (!isValidMemoryName(name)) {
        throw new Error(
          `Invalid memory name "${name}". Use a short kebab-case slug: lowercase letters, digits and dashes, starting with a letter or digit (max 80 characters).`
        );
      }

      const memoryDir = getMemoryDirForScope(scope as MemoryScope);
      const filePath = path.join(memoryDir, `${name}.md`);

      let originalContent = "";
      try {
        originalContent = await fs.readFile(filePath, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      if (action === "delete") {
        if (!originalContent) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No memory named "${name}" in ${memoryDir} - nothing to delete.`,
              },
            ],
          };
        }

        // Deletion goes through the same preview/approval path as a write,
        // shown as "everything removed" so the user sees exactly what is
        // about to be lost.
        if (this.diffApprovalCallback) {
          const approved = await this.diffApprovalCallback(
            originalContent,
            "",
            filePath
          );
          if (!approved) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Memory deletion was rejected by the user.",
                },
              ],
            };
          }
        }

        await fs.unlink(filePath);
        await updateMemoryIndex(memoryDir, name, null);

        return {
          content: [
            {
              type: "text" as const,
              text: `Deleted memory "${name}" (${filePath}) and removed its pointer from ${MEMORY_INDEX_FILENAME}.`,
            },
          ],
        };
      }

      const missing = [
        description ? null : "description",
        type ? null : "type",
        content ? null : "content",
      ].filter(Boolean);
      if (missing.length > 0) {
        throw new Error(
          `Missing required parameter(s) for action 'write': ${missing.join(", ")}.`
        );
      }

      const updatedContent = serializeMemoryFile({
        name,
        description: description as string,
        type: type as MemoryType,
        body: content as string,
      });

      if (this.diffApprovalCallback) {
        const approved = await this.diffApprovalCallback(
          originalContent,
          updatedContent,
          filePath
        );
        if (!approved) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Memory write was rejected by the user.",
              },
            ],
          };
        }
      }

      await fs.mkdir(memoryDir, { recursive: true });
      await fs.writeFile(filePath, updatedContent, "utf-8");

      // The index line's visible title comes from the memory's own name so
      // the two can't drift apart; the trailing hook is its description.
      await updateMemoryIndex(
        memoryDir,
        name,
        `- [${name}](${name}.md) — ${description}`
      );

      const verb = originalContent ? "Updated" : "Created";
      return {
        content: [
          {
            type: "text" as const,
            text: `${verb} ${scope} memory "${name}" (${filePath}) and updated ${MEMORY_INDEX_FILENAME}.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${normalizeError(error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
}
