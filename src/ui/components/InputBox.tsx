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

// Splits a line into plain-text runs and gold/dim/italic mention spans, so
// an inserted "@file" reads as a distinct reference at a glance instead of
// blending into the rest of the draft.
function renderWithMentions(text: string, keyPrefix: string): React.ReactNode {
  if (!text.includes("@")) {
    return text;
  }
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let matchCount = 0;
  for (const match of text.matchAll(MENTION_TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push(text.slice(lastIndex, index));
    }
    parts.push(
      <Text key={`${keyPrefix}_mention_${matchCount++}`} color={MANTU_GOLD} dimColor italic>
        {match[0]}
      </Text>
    );
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
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
            // Find which line and position the cursor is on.
            //
            // Each row is a single <Text> with the mention prefix/cursor
            // highlight nested inside it, rather than sibling <Text>
            // elements side by side in the Box - Ink only wraps long
            // content within one Text's own subtree; sibling elements in a
            // row-direction Box just overflow it. A row wide enough to wrap
            // (a long single-line draft, or the mention-prefixed first line)
            // would overflow un-wrapped, and since Ink's redraw logic
            // still thinks that row is one terminal line tall, the next
            // keystroke's redraw wouldn't clear the extra wrapped line -
            // leaving stale fragments of the old text on screen and making
            // the cursor look like it's stuck on the first line.
            lines.map((line, index) => (
              <Box key={index}>
                <Text wrap="wrap">
                  {index === 0 && (
                    <Text color={isProcessingQuestion ? "gray" : "cyan"} bold>
                      {mentionPrefix}
                    </Text>
                  )}
                  {index === cursorLine ? (
                    <>
                      {renderWithMentions(
                        line.substring(0, cursorPosInLine),
                        `l${index}_before`
                      )}
                      <Text
                        backgroundColor={
                          isProcessingQuestion ? "gray" : "blue"
                        }
                        color="white"
                      >
                        {line.charAt(cursorPosInLine) || " "}
                      </Text>
                      {renderWithMentions(
                        line.substring(cursorPosInLine + 1),
                        `l${index}_after`
                      )}
                    </>
                  ) : (
                    // Regular line without cursor.
                    // For empty lines, just render a space to ensure the line is visible.
                    line === ""
                      ? " "
                      : renderWithMentions(line, `l${index}`)
                  )}
                </Text>
              </Box>
            ))
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
