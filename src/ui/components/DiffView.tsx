import chalk from "chalk";
import { structuredPatch } from "diff";
import { Text } from "ink";
import type { FC } from "react";
import React from "react";

const DIFF_COLORS = {
  addedFg: "#2D5A3D",
  removedFg: "#8B3A3A",
  contextFg: "#6B7280",
} as const;

const DIFF_TYPE_MAP = {
  remove: { color: DIFF_COLORS.removedFg, symbol: "- " },
  add: { color: DIFF_COLORS.addedFg, symbol: "+ " },
  context: { color: DIFF_COLORS.contextFg, symbol: "  " },
} as const;

export interface DiffContent {
  originalContent: string;
  updatedContent: string;
  filePath: string;
}

function computeDiffLines(diff: DiffContent) {
  const patch = structuredPatch(
    diff.filePath,
    diff.filePath,
    diff.originalContent,
    diff.updatedContent,
    undefined,
    undefined,
    { context: 3 }
  );

  const lines: {
    type: "remove" | "add" | "context";
    lineNumber: number;
    content: string;
  }[] = [];
  for (const hunk of patch.hunks) {
    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("-")) {
        lines.push({
          type: "remove",
          lineNumber: oldLineNum,
          content: line.substring(1),
        });
        oldLineNum++;
      } else if (line.startsWith("+")) {
        lines.push({
          type: "add",
          lineNumber: newLineNum,
          content: line.substring(1),
        });
        newLineNum++;
      } else if (line !== "\\ No newline at end of file") {
        lines.push({
          type: "context",
          lineNumber: oldLineNum,
          content: line.substring(1),
        });
        oldLineNum++;
        newLineNum++;
      }
    }
  }

  return lines;
}

export const DiffView: FC<DiffContent & { maxLines?: number }> = ({
  maxLines,
  ...diff
}) => {
  const allLines = computeDiffLines(diff);
  // Capping matters most for the approval prompt: that lives in Ink's
  // *non-static* output, and once that region reaches the terminal height
  // Ink stops doing incremental updates and instead clears the whole
  // terminal and reprints the entire transcript on every render - which
  // shows up as violent full-screen flicker. An unbounded diff (approving a
  // several-hundred-line write_file, say) blows straight past that.
  //
  // The permanent transcript copy (Static output, which doesn't count
  // toward that height) is capped too, just more generously - see
  // FILE_CHANGE_MAX_LINES in Conversation.tsx. Static can't flicker, but a
  // newly created file is one giant "+" hunk with no real diff to speak
  // of, and dumping the whole thing into scrollback isn't useful on its
  // own terms even without the flicker risk.
  const lines =
    maxLines !== undefined && allLines.length > maxLines
      ? allLines.slice(0, maxLines)
      : allLines;
  const hiddenCount = allLines.length - lines.length;

  return (
    <>
      {lines.map((line, index) => {
        const { color, symbol } = DIFF_TYPE_MAP[line.type];
        return (
          <Text key={index}>
            {chalk.hex(color)(`${symbol}${line.lineNumber}: ${line.content}`)}
          </Text>
        );
      })}
      {hiddenCount > 0 && (
        <Text dimColor>
          … {hiddenCount} more diff line{hiddenCount === 1 ? "" : "s"} not
          shown ({diff.filePath} has the full contents)
        </Text>
      )}
    </>
  );
};
