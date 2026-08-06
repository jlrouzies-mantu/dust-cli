import type { Result } from "@dust-tt/client";
import { Err, Ok } from "@dust-tt/client";
import fs from "fs";
import { glob } from "glob";
import path from "path";

import { normalizeError } from "./errors.js";

export interface GrepResult {
  filePath: string;
  lineNumber: number;
  content: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface GrepMatches {
  results: GrepResult[];
  truncated: boolean;
}

const IGNORED_DIRS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/.nyc_output/**",
  "**/bower_components/**",
];

// grep -a "text file" heuristic: a NUL byte anywhere in a reasonably-sized
// prefix is a strong signal this isn't text, so skip it instead of dumping
// binary garbage into the results.
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

const MAX_FILES_SCANNED = 10_000;
const MAX_MATCHES = 500;

/**
 * Recursive text search across files, matching the previous behavior of
 * shelling out to the system `grep -rnHE` binary but implemented in pure JS
 * - that system dependency isn't guaranteed to exist on plain Windows
 * without Git for Windows/WSL installed, so a tool call could silently fail
 * there. `pattern` is treated as an extended-regex, same as `grep -E`.
 */
export async function performGrep(
  pattern: string,
  searchPath: string,
  filePattern = "*",
  options: {
    caseSensitive?: boolean;
    contextBefore?: number;
    contextAfter?: number;
  } = {}
): Promise<Result<GrepMatches, Error>> {
  const {
    caseSensitive = true,
    contextBefore = 0,
    contextAfter = 0,
  } = options;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseSensitive ? "" : "i");
  } catch (error) {
    return new Err(
      new Error(`Invalid regular expression "${pattern}": ${normalizeError(error).message}`)
    );
  }

  try {
    const globPattern =
      filePattern === "*" ? "**/*" : `**/${filePattern}`;
    const files = await glob(globPattern, {
      cwd: searchPath,
      nodir: true,
      dot: false,
      ignore: IGNORED_DIRS,
    });

    const results: GrepResult[] = [];
    let truncated = false;

    for (const relPath of files.slice(0, MAX_FILES_SCANNED)) {
      if (results.length >= MAX_MATCHES) {
        truncated = true;
        break;
      }

      const fullPath = path.join(searchPath, relPath);
      let buffer: Buffer;
      try {
        buffer = await fs.promises.readFile(fullPath);
      } catch {
        continue; // permission denied, broken symlink, etc.
      }
      if (looksBinary(buffer)) {
        continue;
      }

      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i])) {
          continue;
        }
        if (results.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
        results.push({
          filePath: relPath,
          lineNumber: i + 1,
          content: lines[i],
          contextBefore: lines.slice(Math.max(0, i - contextBefore), i),
          contextAfter: lines.slice(i + 1, i + 1 + contextAfter),
        });
      }
    }

    if (files.length > MAX_FILES_SCANNED) {
      truncated = true;
    }

    return new Ok({ results, truncated });
  } catch (error) {
    return new Err(normalizeError(error));
  }
}
