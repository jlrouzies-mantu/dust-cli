import { z } from "zod";

import { normalizeError } from "../../utils/errors.js";
import { MAX_LINE_LENGTH_TEXT_FILE } from "../../utils/fileHandling.js";
import type { GrepResult } from "../../utils/grep.js";
import { performGrep } from "../../utils/grep.js";
import type { McpTool } from "../types/tools.js";

function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_LENGTH_TEXT_FILE) {
    return line;
  }
  return `${line.slice(0, MAX_LINE_LENGTH_TEXT_FILE)}... [cut]`;
}

export class SearchContentTool implements McpTool {
  name = "search_content";
  description =
    "Search for a regular expression within files (recursive, like grep -E). " +
    "Supports optional lines of context around each match.";

  inputSchema = z.object({
    pattern: z
      .string()
      .describe("The regular expression to search for (extended regex syntax)"),
    path: z
      .string()
      .optional()
      .describe("Directory to search in (default: current directory)"),
    file_pattern: z
      .string()
      .optional()
      .describe("File pattern to search within (default: all files)"),
    case_sensitive: z
      .boolean()
      .optional()
      .describe("Whether the match is case-sensitive (default: true)"),
    context_lines: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Number of lines of context to include before and after each match (default: 0)"
      ),
  });

  async execute({
    pattern,
    path = ".",
    file_pattern = "*",
    case_sensitive = true,
    context_lines = 0,
  }: z.infer<typeof this.inputSchema>) {
    const grepRes = await performGrep(pattern, path, file_pattern, {
      caseSensitive: case_sensitive,
      contextBefore: context_lines,
      contextAfter: context_lines,
    });
    if (grepRes.isErr()) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error searching for "${pattern}": ${
              normalizeError(grepRes.error).message
            }`,
          },
        ],
        isError: true,
      };
    }

    const { results, truncated } = grepRes.value;

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No matches found for: ${pattern}`,
          },
        ],
      };
    }

    // Group by file path and sort by line number within each file.
    const fileGroups = new Map<string, GrepResult[]>();
    for (const result of results) {
      const group = fileGroups.get(result.filePath) ?? [];
      group.push(result);
      fileGroups.set(result.filePath, group);
    }
    fileGroups.forEach((group) => group.sort((a, b) => a.lineNumber - b.lineNumber));

    let output = `Found ${results.length} match${
      results.length === 1 ? "" : "es"
    } for "${pattern}" in the following files:\n\n`;

    Array.from(fileGroups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([filePath, group]) => {
        output += `${filePath}:\n`;
        group.forEach((result) => {
          result.contextBefore.forEach((line, i) => {
            const lineNumber = result.lineNumber - result.contextBefore.length + i;
            output += `  ${lineNumber}- ${truncateLine(line)}\n`;
          });
          output += `  ${result.lineNumber}: ${truncateLine(result.content)}\n`;
          result.contextAfter.forEach((line, i) => {
            output += `  ${result.lineNumber + i + 1}- ${truncateLine(line)}\n`;
          });
          if (result.contextBefore.length || result.contextAfter.length) {
            output += "  --\n";
          }
        });
        output += "----------\n";
      });

    if (truncated) {
      output += `\n[Results truncated - refine your pattern or file_pattern to narrow the search.]`;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: output.trim(),
        },
      ],
    };
  }
}
