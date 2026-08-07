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

export const DiffView: FC<DiffContent> = (diff) => {
  const lines = computeDiffLines(diff);

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
    </>
  );
};
