import chalk from "chalk";
import { Box, Text } from "ink";
import React from "react";

import { MANTU_GOLD } from "../../utils/brand.js";

interface InputBoxProps {
  userInput: string;
  cursorPosition: number;
  isProcessingQuestion: boolean;
  mentionPrefix: string;
  claudeCodeMode: boolean;
}

// Matches an "@" mention token (an "@" run into the following non-space
// characters) so it can be picked out visually from the rest of the draft -
// same shape as the "@relative/path" text the "@" file picker inserts (see
// Chat.tsx), but not tied to that specifically: any "@token" typed by hand
// gets the same treatment, which is simpler than trying to remember which
// ones came from the picker.
const MENTION_TOKEN_RE = /@\S+/g;

// Colours "@file" mention tokens gold/bold/italic so an inserted reference
// reads as distinct at a glance instead of blending into the draft. Bold
// rather than dim - dimming MANTU_GOLD washes it out to near-illegible
// against a dark terminal background, defeating the point of highlighting
// it at all.
//
// Returns a pre-coloured *string* rather than React nodes: see the comment
// on the render below for why nothing here may be a nested <Text>.
function colorMentions(text: string): string {
  if (!text.includes("@")) {
    return text;
  }
  let out = "";
  let lastIndex = 0;
  for (const match of text.matchAll(MENTION_TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      out += text.slice(lastIndex, index);
    }
    out += chalk.hex(MANTU_GOLD).bold.italic(match[0]);
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) {
    out += text.slice(lastIndex);
  }
  return out;
}

export function InputBox({
  userInput,
  cursorPosition,
  isProcessingQuestion,
  mentionPrefix,
  claudeCodeMode,
}: InputBoxProps) {
  let currentPos = 0;
  const lines = userInput.split("\n");
  const cursorLine = lines.findIndex((line) => {
    if (
      cursorPosition >= currentPos &&
      cursorPosition <= currentPos + line.length
    ) {
      return true;
    }
    currentPos += line.length + 1;
    return false;
  });

  const cursorPosInLine =
    cursorLine >= 0
      ? cursorPosition -
        (cursorLine === 0
          ? 0
          : lines
              .slice(0, cursorLine)
              .reduce((sum, line) => sum + line.length + 1, 0))
      : 0;

  return (
    <Box flexDirection="column" marginTop={0} paddingTop={0}>
      <Box
        borderStyle="classic"
        borderColor="gray"
        padding={0}
        paddingX={1}
        marginTop={0}
      >
        <Box flexDirection="column">
          {
            // Each row is a single <Text> holding one pre-coloured string,
            // with **no nested <Text> elements and no sibling children**.
            // Both constraints are load-bearing, and each comes from a real
            // bug:
            //
            // - Sibling <Text> elements laid out side by side in a
            //   row-direction Box don't wrap; Ink only wraps within one
            //   Text's own subtree. A row wide enough to wrap (a long
            //   draft, or the mention-prefixed first line) overflowed
            //   un-wrapped, and since Ink still thought the row was one
            //   line tall the next keystroke's redraw left stale fragments
            //   behind and the cursor looked stuck on the first line.
            //
            // - Nesting <Text> inside the wrapping <Text> fixed that, but
            //   mis-measures the row when a plain-string child changes from
            //   empty to non-empty in a single update - which is exactly
            //   what Up-arrow history recall does ("" -> the whole recalled
            //   message at once). The box's bottom border was then drawn
            //   with the row's own text written into it
            //   ("+-so in wieghts ----" instead of "+--------"). Typing
            //   never triggered it because each keystroke grows an
            //   already-non-empty child. Reduced to a minimal case: the
            //   nesting alone causes it, independently of backgroundColor.
            //
            // Pre-colouring with chalk satisfies both: one Text, one string,
            // so wrapping works and there is nothing for Ink to mis-measure.
            // Same reasoning as the status bar's pre-coloured segments in
            // Conversation.tsx.
            lines.map((line, index) => {
              const prefix =
                index === 0
                  ? (isProcessingQuestion ? chalk.gray : chalk.cyan).bold(
                      mentionPrefix
                    )
                  : "";

              let body: string;
              if (index === cursorLine) {
                const cursorChar = line.charAt(cursorPosInLine) || " ";
                const highlight = isProcessingQuestion
                  ? chalk.bgGray.white
                  : chalk.bgBlue.white;
                body =
                  colorMentions(line.substring(0, cursorPosInLine)) +
                  highlight(cursorChar) +
                  colorMentions(line.substring(cursorPosInLine + 1));
              } else {
                // A space for an empty line, so the row stays visible.
                body = line === "" ? " " : colorMentions(line);
              }

              return (
                <Box key={index}>
                  <Text wrap="wrap">{prefix + body}</Text>
                </Box>
              );
            })
          }
        </Box>
      </Box>
      {/*
        No permission-mode indicator here: it lives in the status bar (see
        Conversation.tsx), where it is always shown, including in normal mode.
        Repeating it under the input would be the same state twice.
      */}
      {claudeCodeMode && (
        <Box>
          <Text color="magenta" dimColor>
            ◊ claude code mode on
          </Text>
        </Box>
      )}
      {/*
        No loop indicator here: an armed loop gets the persistent blue
        "Looping" block above the input (see Conversation.tsx), which carries
        the prompt and the run count. A one-liner here as well would show the
        same state twice.
      */}
    </Box>
  );
}
