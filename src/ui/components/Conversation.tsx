import { assertNever } from "@dust-tt/client";
import chalk from "chalk";
import { Box, Static, Text } from "ink";
import Spinner from "ink-spinner";
// biome-ignore lint/plugin/noBulkLodash: existing usage
import _ from "lodash";
import type { FC } from "react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { TodoItem } from "../../mcp/tools/todoWrite.js";
import {
  BUG_REPORT_YELLOW,
  CODE_BLOCK_BG,
  LOOP_BODY_BG,
  LOOP_BODY_FG,
  LOOP_TITLE_BG,
  LOOP_TITLE_FG,
  MODE_PLAN_FG,
  MANTU_AGENT_ACCENT,
  MANTU_GOLD,
  MANTU_PURPLE,
  HINT_ORANGE_FADED,
  MANTU_THINKING_PINK,
  MANTU_THINKING_PINK_FADED,
  MANTU_USER_ACCENT,
  PICKER_PURPLE,
  QUEUED_BODY_BG,
  QUEUED_BODY_FG,
  QUEUED_TITLE_BG,
  QUEUED_TITLE_FG,
  contextUsageColor,
  creditsUsageColor,
  STATUS_BAR_BRANCH,
  STATUS_BAR_TEXT,
  STATUS_BAR_WORKSPACE,
  STEERED_BODY_BG,
  STEERED_BODY_FG,
  STEERED_TITLE_BG,
  STEERED_TITLE_FG,
} from "../../utils/brand.js";
import type { ContextUsage } from "../../utils/contextUsage.js";
import type { CreditsUsage } from "../../utils/creditsInfo.js";
import type { ModelStatus } from "../../utils/modelSelection.js";
import type { MarkdownSegment } from "../../utils/markdown.js";
import { renderMarkdownSegments } from "../../utils/markdown.js";
import { formatFileSize, isImageFile } from "../../utils/fileHandling.js";
import type { ChatMode } from "../../utils/chatMode.js";
import { chatModeColor, chatModeLabel } from "../../utils/chatMode.js";
import { getGitBranch } from "../../utils/gitInfo.js";
import { useTerminalSize } from "../../utils/hooks/use_terminal_size.js";
import type { LoopState } from "../../utils/loopController.js";
import { loopBlockTitle } from "../../utils/loopController.js";
import { clearTerminal } from "../../utils/terminal.js";
import { CLI_VERSION, UPSTREAM_CLI_VERSION } from "../../utils/version.js";
import type { Command } from "../commands/types.js";
import { CommandSelector } from "./CommandSelector.js";
import type { DiffContent } from "./DiffView.js";
import { DiffView } from "./DiffView.js";
import type { UploadedFile } from "./FileUpload.js";
import type { InlineSelectorItem } from "./InlineSelector.js";
import { InlineSelector } from "./InlineSelector.js";
import { InputBox } from "./InputBox.js";
import { ThinkingIcon } from "./ThinkingIcon.js";

// Compact thousands formatting for the status bar's counters (tokens and
// credits alike), so a long figure can't push the bar into another wrapped
// line. Named generically since it's no longer token-specific.
function formatCompactCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatPercent(used: number, total: number): string {
  if (total <= 0) {
    return "0";
  }
  return ((used / total) * 100).toFixed(0);
}

// Width of the context gauge, in characters.
const CONTEXT_GAUGE_WIDTH = 16;

/**
 * Renders a filled/empty bar for a 0-100 percentage, the filled part in the
 * gauge colour for that level and the remainder dimmed.
 *
 * Only uses the CP437 shade ramp (U+2588 full, U+2593 dark, U+2592 medium,
 * U+2591 light) so it still renders on the legacy Windows consoles this
 * fork targets - the eighth-block glyphs (▏▎▍▌…) that would give finer
 * steps are exactly the sort of Unicode that comes out as garbage there.
 *
 * The two mid shades stand in for a fractional trailing cell, which triples
 * the effective resolution: at 16 cells that's ~2% per visible step rather
 * than 6.25%.
 */
function renderContextGauge(percentUsed: number): string {
  const clamped = Math.max(0, Math.min(100, percentUsed));
  const exact = (clamped / 100) * CONTEXT_GAUGE_WIDTH;
  const full = Math.floor(exact);
  const remainder = exact - full;

  let partial = "";
  if (full < CONTEXT_GAUGE_WIDTH) {
    if (remainder >= 0.66) {
      partial = "▓";
    } else if (remainder >= 0.33) {
      partial = "▒";
    }
  }
  // Any non-zero usage shows something, so the bar never reads as empty
  // while tokens are actually in use.
  if (clamped > 0 && full === 0 && !partial) {
    partial = "▒";
  }

  const empty = CONTEXT_GAUGE_WIDTH - full - (partial ? 1 : 0);
  return (
    chalk.hex(contextUsageColor(clamped))("█".repeat(full) + partial) +
    chalk.dim("░".repeat(empty))
  );
}

// Number of dots in the credits meter, so each one is a round 10%.
const CREDITS_DOT_COUNT = 10;

/**
 * Renders the credits meter as a dot ramp, coloured on a continuous lilac ->
 * red-lilac fade (see creditsUsageColor).
 *
 * Deliberately a different shape *and* a different colour behaviour from the
 * context gauge's block ramp: they sit next to each other in the status bar,
 * so "spent budget" and "window pressure" shouldn't read as the same widget.
 *
 * Caveat: unlike the context gauge's CP437 blocks, U+25CF/U+25CB aren't in
 * that legacy codepage, so very old Windows consoles may not have them in
 * their font. Chosen anyway for how much better the ramp reads; swap for a
 * shade ramp if they ever show up as replacement boxes.
 */
function renderCreditsDots(percentUsed: number): string {
  const clamped = Math.max(0, Math.min(100, percentUsed));
  // Any non-zero spend lights at least one dot, so the meter never reads as
  // untouched once credits have actually been used.
  const filled =
    clamped === 0
      ? 0
      : Math.max(
          1,
          Math.min(
            CREDITS_DOT_COUNT,
            Math.round((clamped / 100) * CREDITS_DOT_COUNT)
          )
        );
  return (
    chalk.hex(creditsUsageColor(clamped))("●".repeat(filled)) +
    chalk.dim("○".repeat(CREDITS_DOT_COUNT - filled))
  );
}

// Caps a file_change diff even in its permanent, Static-rendered form - a
// newly created file has no real "diff" at all, just every line as a "+",
// so an unbounded view here means a several-hundred-line file gets dumped
// into the transcript wholesale. Static output doesn't cause the ephemeral
// approval prompt's flicker problem (see DiffView's own comment on why that
// one stays uncapped there), but "won't cause flicker" isn't the same as
// "should show everything" - the file itself is right there on disk.
const FILE_CHANGE_MAX_LINES = 30;

export type ConversationItem = { key: string } & (
  | {
      type: "welcome_header";
      agentName: string;
      agentDescription: string;
    }
  | {
      type: "user_message";
      firstName: string;
      content: string;
      index: number;
    }
  | {
      type: "user_message_attachments";
      attachments: UploadedFile[];
      index: number;
    }
  | {
      type: "agent_message_header";
      agentName: string;
      index: number;
    }
  | {
      type: "agent_message_content_line";
      text: string;
      index: number;
    }
  | {
      // A markdown-rendered prose segment of the agent's answer (not
      // wrapped in a border — only code segments are, see below).
      type: "agent_message_text_segment";
      text: string;
      index: number;
    }
  | {
      // A code-fence segment of the agent's answer, rendered on its own
      // (not the whole message) so only the code itself gets a border.
      type: "agent_message_code_block";
      text: string;
      index: number;
    }
  | {
      // A turn that stopped early: either steered (redirected, with the
      // follow-up message continuing right below) or plainly cancelled by
      // the user.
      type: "agent_message_cancelled";
      steered?: boolean;
    }
  | {
      // A snapshot of the todo list at the point todo_write was called.
      // Pushed as a fresh item each update (Static is append-only), same
      // as how Claude Code prints a new checklist snapshot per call.
      type: "todo_list";
      todos: TodoItem[];
      index: number;
    }
  | {
      // The full plan, pushed the moment present_plan is called - before the
      // user has even decided, and before the ephemeral approval selector
      // opens. Immutable from here on: Static never re-renders an item once
      // printed, which is exactly why this exists as its own item instead of
      // showing the plan only in the (ephemeral) approval prompt's header.
      //
      // That used to be the only place the plan text appeared, and it broke:
      // Ink's ephemeral region is erased and redrawn by moving the cursor up
      // N lines and repainting, and that arithmetic desyncs once the region
      // is taller than the terminal (a real plan easily is). The visible
      // symptom was the plan appearing twice - the old ephemeral copy never
      // fully erased, sitting above the new permanent one pushed on
      // resolution. Printing it exactly once, immediately, and never as
      // ephemeral content again is what actually fixes that, rather than
      // just tuning how many lines the ephemeral copy was allowed to show.
      type: "plan_proposed";
      planMarkdown: string;
    }
  | {
      // The user's decision on the plan proposed above. Deliberately carries
      // no plan text - it's already permanent on screen from plan_proposed,
      // and repeating it here is exactly what caused the duplicate-rendering
      // bug this type replaces (see plan_proposed's comment).
      type: "plan_decision";
      // Where the plan was saved (null when the save failed, or when it was
      // rejected and therefore never saved).
      filePath: string | null;
      // Which of the four decisions was taken, and the rejection comment when
      // one was given - both worth keeping in scrollback, since "approved but
      // told to wait" and "approved, go" read very differently later.
      outcome: "approved-auto" | "approved-wait" | "rejected";
      comment?: string;
    }
  | ({
      // A file write/edit that was approved and applied. Pushed once
      // approval resolves (whether interactively or via auto-accept), so it
      // stays visible in scrollback - unlike the ephemeral approval-prompt
      // preview, which disappears as soon as the decision is made.
      type: "file_change";
    } & DiffContent)
  | {
      type: "separator";
    }
);

interface ConversationProps {
  conversationItems: ConversationItem[];
  isProcessingQuestion: boolean;
  // True from the moment Esc/Ctrl+C requests a cancel until the turn
  // actually ends - overrides the Thinking/tool-status line below with an
  // immediate "Cancelling..." so the keypress doesn't look ignored during
  // the round trip to the server.
  isCancelling: boolean;
  actionStatus: string | null;
  queuedMessages: {
    id: string;
    text: string;
    steered: boolean;
    loop?: boolean;
  }[];
  streamingContentPreview: MarkdownSegment[];
  thinkingContentPreview: string;
  showExitHint: boolean;
  transientHint: string | null;
  retryStatus: string | null;
  workspaceName: string | null;
  // The model in use - the agent's own unless /model or /effort is
  // overriding it, with `overridden` distinguishing the two.
  modelStatus: ModelStatus | null;
  consumedCredits: CreditsUsage | null;
  contextUsage: ContextUsage | null;
  userInput: string;
  cursorPosition: number;
  mentionPrefix: string;
  conversationId: string | null;
  stdout: NodeJS.WriteStream | null;
  showCommandSelector: boolean;
  commandQuery: string;
  selectedCommandIndex: number;
  commandCursorPosition: number;
  commands?: Command[];
  chatMode: ChatMode;
  claudeCodeMode: boolean;
  // Non-null while a /loop is armed; drives the persistent Looping block.
  loop: LoopState | null;
  inlineSelector?: {
    items: InlineSelectorItem[];
    query: string;
    selectedIndex: number;
    prompt?: string;
    header?: React.ReactNode;
    // Checklist modes (currently /skills): draws [x]/[ ] boxes and shows
    // the toggle key hint. `footerNote` is an advisory rendered under the
    // list in faded orange italic.
    multiSelect?: boolean;
    footerNote?: string;
  } | null;
}

const _Conversation: FC<ConversationProps> = ({
  conversationItems,
  isProcessingQuestion,
  isCancelling,
  actionStatus,
  queuedMessages,
  streamingContentPreview,
  thinkingContentPreview,
  showExitHint,
  transientHint,
  retryStatus,
  workspaceName,
  modelStatus,
  consumedCredits,
  contextUsage,
  userInput,
  cursorPosition,
  mentionPrefix,
  conversationId,
  stdout,
  showCommandSelector,
  commandQuery,
  selectedCommandIndex,
  commandCursorPosition,
  commands = [],
  chatMode,
  claudeCodeMode,
  loop,
  inlineSelector,
}: ConversationProps) => {
  // Computed once per mount (not per keystroke) — getGitBranch spawns a
  // subprocess, which would otherwise run on every render since this
  // component re-renders on every keystroke.
  const { displayPath, gitBranch } = useMemo(() => {
    const cwd = process.cwd();
    const home = process.env.HOME || "";
    return {
      displayPath:
        home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd,
      gitBranch: getGitBranch(cwd),
    };
  }, []);

  // See the comment at the render site for why the status bar is laid out
  // into lines here rather than left to Ink's own text wrapping.
  const statusBarLines = useMemo(() => {
    const SEPARATOR = " · ";
    // Each segment carries its plain text (for width math, since the
    // colored form is full of zero-width escape codes) alongside the
    // pre-colored string that actually gets rendered.
    const segments: { plain: string; colored: string }[] = [];
    const add = (plain: string, colored: string) =>
      segments.push({ plain, colored });

    // Mode first, and unconditionally - it's the one field that changes what
    // the agent is allowed to do, so it gets the most stable position (the
    // segments after it come and go depending on what's available).
    const modeLabel = chatModeLabel(chatMode);
    add(modeLabel, chalk.hex(chatModeColor(chatMode))(modeLabel));

    if (workspaceName) {
      add(workspaceName, chalk.hex(STATUS_BAR_WORKSPACE)(workspaceName));
    }
    // The model in use, always shown when known. Purple while /model or
    // /effort is overriding the agent's own configuration, neutral grey
    // when it's just the agent's configured model - so a deviation reads
    // as one at a glance, rather than looking the same as the default.
    // Sits early, next to the mode, since like the mode it's about how the
    // agent behaves rather than where you are.
    if (modelStatus) {
      add(
        modelStatus.text,
        modelStatus.overridden
          ? chalk.hex(PICKER_PURPLE)(modelStatus.text)
          : chalk.hex(STATUS_BAR_TEXT)(modelStatus.text)
      );
    }
    add(displayPath, chalk.hex(MANTU_GOLD)(displayPath));
    if (gitBranch) {
      add(gitBranch, chalk.hex(STATUS_BAR_BRANCH)(gitBranch));
    }
    if (conversationId) {
      // The full sId, not a truncated prefix - a shortened ID here doesn't
      // match the one shown in the web app (or the one --conversationId
      // expects), which made it look wrong/unusable for resuming.
      add(conversationId, chalk.dim(conversationId));
    }
    if (contextUsage) {
      const used = formatCompactCount(contextUsage.contextUsage);
      const total = formatCompactCount(contextUsage.contextSize);
      const percent = formatPercent(
        contextUsage.contextUsage,
        contextUsage.contextSize
      );
      // Gauge is driven by the raw ratio rather than the rounded display
      // string, so the bar and colour step on the true value.
      const ratio =
        contextUsage.contextSize > 0
          ? (contextUsage.contextUsage / contextUsage.contextSize) * 100
          : 0;
      const label = `${used}/${total} (${percent}%) context`;
      // Plain form counts the gauge's cells plus the joining space, since
      // each block character occupies exactly one column.
      add(
        `${"x".repeat(CONTEXT_GAUGE_WIDTH)} ${label}`,
        `${renderContextGauge(ratio)} ${chalk.hex(contextUsageColor(ratio))(
          label
        )}`
      );
    }
    if (consumedCredits !== null) {
      const limitSuffix =
        consumedCredits.limit !== null
          ? `/${formatCompactCount(consumedCredits.limit)} (${formatPercent(
              consumedCredits.consumed,
              consumedCredits.limit
            )}%)`
          : "";
      const text = `${formatCompactCount(
        consumedCredits.consumed
      )}${limitSuffix} credits used`;
      // Only shown when there's a limit to measure against - without one
      // there's no percentage, so a meter would be meaningless.
      if (consumedCredits.limit !== null) {
        const ratio =
          consumedCredits.limit > 0
            ? (consumedCredits.consumed / consumedCredits.limit) * 100
            : 0;
        // The label deliberately stays neutral grey while only the dots
        // carry the ramp - the reverse of the context field, where bar and
        // label share a colour. One more axis of separation between them.
        add(
          `${"x".repeat(CREDITS_DOT_COUNT)} ${text}`,
          `${renderCreditsDots(ratio)} ${chalk.hex(STATUS_BAR_TEXT)(text)}`
        );
      } else {
        add(text, chalk.hex(STATUS_BAR_TEXT)(text));
      }
    }

    // Greedily pack whole segments into lines that fit. The budget is
    // deliberately conservative - 1 column for the container's paddingLeft,
    // plus 5 more of slack - rather than the exact terminal width: getting
    // right up against the real edge is what triggers the wrap-ansi 24-bit
    // colour bug this whole packing scheme exists to avoid in the first
    // place (see the render site's comment). Ink's own truncate-end still
    // has to measure a string that's already full of concatenated hex SGR
    // codes (segments are pre-colored via chalk, not nested <Text>), and
    // getting that measurement wrong by even a couple of columns is enough
    // for the terminal itself to wrap the overflow - which is exactly what
    // showed up as the credits segment tearing across two lines with the
    // colour boundary in the wrong place. The extra slack costs an earlier
    // line break sometimes; that's a fine trade against a broken one.
    const maxWidth = Math.max(20, (stdout?.columns || 80) - 6);
    const lines: { plain: string; colored: string }[] = [];
    for (const segment of segments) {
      const current = lines[lines.length - 1];
      if (!current) {
        lines.push({ ...segment });
        continue;
      }
      if (current.plain.length + SEPARATOR.length + segment.plain.length <=
        maxWidth
      ) {
        current.plain += SEPARATOR + segment.plain;
        current.colored += chalk.dim(SEPARATOR) + segment.colored;
      } else {
        lines.push({ ...segment });
      }
    }
    return lines.map((line) => line.colored);
  }, [
    chatMode,
    workspaceName,
    modelStatus,
    displayPath,
    gitBranch,
    conversationId,
    contextUsage,
    consumedCredits,
    stdout?.columns,
  ]);

  return (
    <Box flexDirection="column">
      <Static items={conversationItems}>
        {(item) => {
          return (
            <StaticConversationItem
              item={item}
              stdout={stdout}
              key={item.key}
            />
          );
        }}
      </Static>

      {retryStatus && (
        <Box marginTop={1}>
          <Text color="yellow">
            <Spinner type="dots" /> {retryStatus}
          </Text>
        </Box>
      )}

      {/*
        Both this streaming preview and the spinner block below are gated on
        `!inlineSelector` too: while an inline selector prompt is open
        (approving a tool call, a diff, or a plan), the turn is effectively
        paused waiting on the user, so a ticking "Thinking…" spinner is both
        inaccurate and - more importantly - the thing that forces a full
        terminal repaint on every animation frame. That repaint is fine for a
        few lines, but is exactly what made a tall prompt (a full plan, a
        large diff) flicker badly enough that they used to be capped instead.
        Freezing here removes the repeated re-render, which is what makes
        showing a plan in full (see the "plan" mode header below) safe.
      */}
      {/*
        The reasoning preview only while there's no answer text yet - once
        content tokens start arriving the chain-of-thought is done, and the
        streaming answer preview below takes over the same slot instead of
        stacking both.
      */}
      {isProcessingQuestion &&
        !inlineSelector &&
        streamingContentPreview.length === 0 &&
        thinkingContentPreview && (
          <Box marginLeft={2}>
            <Text color={MANTU_THINKING_PINK_FADED} italic>
              {thinkingContentPreview}
            </Text>
          </Box>
        )}

      {isProcessingQuestion &&
        !inlineSelector &&
        streamingContentPreview.map((segment, index) =>
          segment.type === "code" ? (
            <Box
              key={`streaming_code_${index}`}
              flexDirection="column"
              alignSelf="flex-start"
              marginLeft={2}
              marginBottom={1}
              paddingX={1}
              borderStyle="classic"
              borderColor="gray"
            >
              <Text backgroundColor={CODE_BLOCK_BG}>{segment.content}</Text>
            </Box>
          ) : (
            <Box key={`streaming_text_${index}`} marginLeft={2}>
              <Text>{segment.content}</Text>
            </Box>
          )
        )}

      {isProcessingQuestion && !inlineSelector && (
        <Box marginTop={1}>
          {isCancelling ? (
            <Text color="red">
              {" "}
              ✗ Cancelling
              <Spinner type="simpleDots" />
            </Text>
          ) : actionStatus ? (
            <Text color="yellow">
              {" "}
              <ThinkingIcon /> {actionStatus}
              <Spinner type="simpleDots" />
            </Text>
          ) : (
            <Text color={MANTU_THINKING_PINK}>
              {" "}
              <ThinkingIcon /> Thinking
              <Spinner type="simpleDots" />
            </Text>
          )}
        </Box>
      )}

      {(() => {
        const terminalWidth = stdout?.columns || 80;

        // Loop ticks are enqueued like any other message, but they're
        // represented by the persistent Looping block below rather than the
        // amber Queued one - showing the same prompt in both would read as
        // two pending messages when there's only one.
        const steeredMessages = queuedMessages.filter((m) => m.steered);
        const loopMessages = queuedMessages.filter((m) => m.loop && !m.steered);
        const plainQueued = queuedMessages.filter((m) => !m.steered && !m.loop);

        const renderBlock = (
          key: string,
          titleText: string,
          rows: { id: string; text: string }[],
          titleBg: string,
          titleFg: string,
          bodyBg: string,
          bodyFg: string
        ) => {
          const rowTexts = rows.map(
            (row) =>
              `${row.text.split("\n")[0]}${row.text.includes("\n") ? " …" : ""}`
          );

          // Every row is padded to one shared width so the background
          // paints as a solid block: Ink's backgroundColor only fills
          // behind actual characters, so a short row would otherwise
          // leave a ragged edge (same reason code blocks need
          // padCodeBlockToBlockWidth). Capped to the terminal width so a
          // narrow window can't wrap a row and break the block.
          const blockWidth = Math.min(
            Math.max(titleText.length, ...rowTexts.map((t) => t.length)) + 2,
            terminalWidth - 2
          );
          const padRow = (text: string) =>
            ` ${text} `.padEnd(blockWidth).slice(0, blockWidth);

          return (
            <Box key={key} flexDirection="column" marginTop={1} marginLeft={1}>
              <Text backgroundColor={titleBg} color={titleFg} bold>
                {padRow(titleText)}
              </Text>
              {rowTexts.map((text, index) => (
                <Text
                  key={rows[index].id}
                  backgroundColor={bodyBg}
                  color={bodyFg}
                >
                  {padRow(text)}
                </Text>
              ))}
            </Box>
          );
        };

        // Numbered rows, as the queue is ordered and the position matters.
        const numbered = (items: typeof queuedMessages) =>
          items.map((item, index) => ({
            id: item.id,
            text: `${index + 1}. ${item.text}`,
          }));

        return (
          <>
            {/* Steered messages interrupt the current turn and run first, so
                this block sits above the plain queue. */}
            {steeredMessages.length > 0 &&
              renderBlock(
                "steered",
                `Steered (${steeredMessages.length}) — interrupting the current turn, sent next`,
                numbered(steeredMessages),
                STEERED_TITLE_BG,
                STEERED_TITLE_FG,
                STEERED_BODY_BG,
                STEERED_BODY_FG
              )}
            {plainQueued.length > 0 &&
              renderBlock(
                "queued",
                `Queued (${plainQueued.length}) — Up/Backspace to edit · Esc to cancel · Ctrl+S to steer`,
                numbered(plainQueued),
                QUEUED_TITLE_BG,
                QUEUED_TITLE_FG,
                QUEUED_BODY_BG,
                QUEUED_BODY_FG
              )}
            {/* Persistent while a loop is armed - unlike the two above, it
                isn't gated on anything being queued. A loop sends messages
                and spends credits on its own, so it stays on screen for as
                long as that's true. Rendered last so it keeps a fixed
                position directly above the input as the blocks above it come
                and go. */}
            {loop &&
              renderBlock(
                "looping",
                // terminalWidth - 4: the block is capped at terminalWidth - 2
                // and padRow spends two of those on the surrounding spaces,
                // so that's what a title can actually occupy without being
                // sliced.
                loopBlockTitle(
                  loop,
                  loopMessages.length > 0,
                  terminalWidth - 4
                ),
                [{ id: `loop_prompt_${loop.id}`, text: loop.prompt }],
                LOOP_TITLE_BG,
                LOOP_TITLE_FG,
                LOOP_BODY_BG,
                LOOP_BODY_FG
              )}
          </>
        );
      })()}

      <InputBox
        userInput={showCommandSelector ? `/${commandQuery}` : userInput}
        cursorPosition={
          showCommandSelector ? commandCursorPosition + 1 : cursorPosition
        }
        isProcessingQuestion={isProcessingQuestion}
        mentionPrefix={mentionPrefix}
        claudeCodeMode={claudeCodeMode}
      />
      {showCommandSelector && (
        <CommandSelector
          query={commandQuery}
          selectedIndex={selectedCommandIndex}
          commands={commands}
          onSelect={() => {}}
        />
      )}
      {!showCommandSelector && inlineSelector && (
        <InlineSelector
          items={inlineSelector.items}
          query={inlineSelector.query}
          selectedIndex={inlineSelector.selectedIndex}
          prompt={inlineSelector.prompt}
          header={inlineSelector.header}
          multiSelect={inlineSelector.multiSelect}
          footer={
            inlineSelector.multiSelect ? (
              <>
                <Text dimColor>
                  Space toggles · Enter saves · Esc cancels
                </Text>
                {inlineSelector.footerNote && (
                  <Text color={HINT_ORANGE_FADED} italic>
                    {inlineSelector.footerNote}
                  </Text>
                )}
              </>
            ) : undefined
          }
        />
      )}
      {showExitHint && (
        <Box paddingLeft={1}>
          <Text color="yellow">Press Ctrl+C again to exit</Text>
        </Box>
      )}
      {transientHint && (
        <Box paddingLeft={1}>
          <Text color="yellow">{transientHint}</Text>
        </Box>
      )}
      {!showCommandSelector && !inlineSelector && (
        <>
          <Box marginTop={0} paddingLeft={1}>
            <Text dimColor>
              {isProcessingQuestion ? "Enter to queue" : "Enter to send"} ·
              Ctrl/Shift+Enter for new line · ESC to{" "}
              {isProcessingQuestion ? "interrupt" : "clear"}
              {isProcessingQuestion && " · Ctrl+S to steer"}
              {conversationId && " · Ctrl+G to open in browser"}
            </Text>
          </Box>
          {/*
            A thin rule between the keyboard-shortcut hint and the status
            bar below it - "how to use this box" and "what's going on"
            were sitting flush against each other with nothing to tell
            them apart at a glance.
          */}
          <Box paddingLeft={1}>
            <Text dimColor>
              {"─".repeat(Math.max(0, (stdout?.columns || 80) - 2))}
            </Text>
          </Box>
        </>
      )}
      {/*
        The status bar is packed into lines by hand (see statusBarLines) and
        each line rendered with wrap disabled, rather than handing one long
        string to Ink and letting it wrap.

        Ink wraps via wrap-ansi, which is supposed to re-emit the active SGR
        codes at the start of each new line but doesn't do so reliably for
        24-bit color: at some widths the continuation line comes out with no
        escape at all and renders in the default foreground. It's
        width-dependent, which is what made it look intermittent. Packing
        whole segments per line means a break never lands mid-segment, so
        every rendered line already carries its own complete escapes and
        nothing has to be re-emitted.

        The agent name is deliberately absent - the input box's own
        "@agent" prefix already shows it, directly above this line.
      */}
      <Box flexDirection="column" paddingLeft={1}>
        {statusBarLines.map((line, index) => (
          <Text key={index} wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
};

interface StaticConversationItemProps {
  item: ConversationItem;
  stdout: NodeJS.WriteStream | null;
}

const StaticConversationItem: FC<StaticConversationItemProps> = ({
  item,
  stdout,
}) => {
  const terminalWidth = stdout?.columns || 80;
  const rightPadding = 4;

  switch (item.type) {
    case "welcome_header": {
      const cwd = process.cwd();
      const home = process.env.HOME || "";
      const displayPath =
        home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
      const gitBranch = getGitBranch(cwd);

      return (
        <Box flexDirection="column">
          <Box marginTop={1} marginBottom={1}>
            <Text color={MANTU_GOLD}>{"_".repeat(terminalWidth)}</Text>
          </Box>
          <Box>
            <Box flexDirection="column" marginRight={2}>
              <Box>
                <Text color={MANTU_PURPLE} dimColor>
                  {"█"}
                </Text>
                <Text color={MANTU_PURPLE}>{"▀▄ "}</Text>
                <Text color={MANTU_PURPLE} dimColor>
                  {"█ █"}
                </Text>
              </Box>
              <Box>
                <Text color={MANTU_PURPLE} dimColor>
                  {"█"}
                </Text>
                <Text color={MANTU_PURPLE}>{"▄▀ "}</Text>
                <Text color={MANTU_PURPLE}>{"█▄█"}</Text>
              </Box>
              <Box>
                <Text color={MANTU_GOLD} dimColor>
                  {"█▀▀ "}
                </Text>
                <Text color={MANTU_GOLD} dimColor>
                  {"▀█▀"}
                </Text>
              </Box>
              <Box>
                <Text color={MANTU_GOLD}>{"▄██ "}</Text>
                <Text color={MANTU_GOLD} dimColor>
                  {" █ "}
                </Text>
              </Box>
            </Box>
            <Box flexDirection="column" justifyContent="center">
              <Text bold color={MANTU_PURPLE}>
                MANTU FORK
              </Text>
              <Text color={BUG_REPORT_YELLOW}>
                Report bug here: https://github.com/jlrouzies-mantu/dust-cli
              </Text>
              {/* No folder path here - the status bar already shows it. */}
              <Text dimColor>
                Dust CLI v{CLI_VERSION} (upstream v{UPSTREAM_CLI_VERSION})
              </Text>
              <Text dimColor>
                Chatting with{" "}
                <Text bold dimColor>
                  @{item.agentName}
                </Text>
                {" · "}Use{" "}
                <Text bold dimColor>
                  /switch
                </Text>{" "}
                to change agent.
              </Text>
              <Text dimColor>
                Type your message below and press Enter to send.
              </Text>
            </Box>
          </Box>
          <Box marginBottom={1}>
            <Text color={MANTU_GOLD}>{"_".repeat(terminalWidth)}</Text>
          </Box>
        </Box>
      );
    }
    case "user_message":
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text bold color={MANTU_USER_ACCENT}>
              {item.firstName ?? "You"}
            </Text>
          </Box>
          <Box
            marginLeft={2}
            marginRight={rightPadding}
            flexDirection="column"
            width={terminalWidth - rightPadding - 2}
          >
            <Text wrap="wrap">
              {item.content.replace(/^\n+/, "").replace(/\n+$/, "")}
            </Text>
          </Box>
        </Box>
      );
    case "user_message_attachments":
      return (
        <Box flexDirection="column" marginLeft={2} marginBottom={1}>
          <Box borderStyle="classic" borderColor="gray" padding={1}>
            <Box flexDirection="column">
              <Text color="gray" bold>
                📎 {item.attachments.length} attachment
                {item.attachments.length > 1 ? "s" : ""}
              </Text>
              {item.attachments.map((file, index) => {
                const isImage = isImageFile(file.fileName);
                return (
                  <Box key={index}>
                    <Text color={isImage ? "yellow" : "cyan"}>
                      {isImage ? "🖼️  " : "📄 "} {file.fileName}
                    </Text>
                    <Text color="gray"> ({formatFileSize(file.fileSize)})</Text>
                  </Box>
                );
              })}
            </Box>
          </Box>
        </Box>
      );
    case "agent_message_header":
      return (
        <Box>
          <Text bold color={MANTU_AGENT_ACCENT}>
            {item.agentName}
          </Text>
        </Box>
      );
    case "agent_message_content_line":
      return (
        <Box marginLeft={2}>
          <Text>{item.text}</Text>
        </Box>
      );
    case "agent_message_text_segment":
      return (
        <Box marginLeft={2}>
          <Text>{item.text}</Text>
        </Box>
      );
    case "agent_message_code_block":
      return (
        <Box
          flexDirection="column"
          alignSelf="flex-start"
          marginLeft={2}
          marginBottom={1}
          paddingX={1}
          borderStyle="classic"
          borderColor="gray"
        >
          <Text backgroundColor={CODE_BLOCK_BG}>{item.text}</Text>
        </Box>
      );
    case "agent_message_cancelled":
      return (
        <Box marginBottom={1} marginTop={1}>
          {item.steered ? (
            <Text color="gray">┌ Steered</Text>
          ) : (
            <Text color="red">✗ Cancelled</Text>
          )}
        </Box>
      );
    case "plan_proposed": {
      // Rendered through the same markdown pipeline as an agent answer, so a
      // plan's headings, lists and code fences look like they do anywhere
      // else - a plan is prose meant to be read, not a literal blob. Printed
      // once, in full, the moment the plan is proposed - see the type's
      // comment for why this must never be shown as ephemeral content again.
      const segments = renderMarkdownSegments(item.planMarkdown);
      return (
        <Box
          flexDirection="column"
          alignSelf="flex-start"
          marginLeft={2}
          marginBottom={1}
          paddingX={1}
          borderStyle="round"
          borderColor={MODE_PLAN_FG}
        >
          <Text bold color={MODE_PLAN_FG}>
            ◇ Plan proposed — awaiting your decision
          </Text>
          {segments.map((segment, index) =>
            segment.type === "code" ? (
              <Box
                key={index}
                flexDirection="column"
                alignSelf="flex-start"
                marginY={1}
                paddingX={1}
                borderStyle="classic"
                borderColor="gray"
              >
                <Text backgroundColor={CODE_BLOCK_BG}>{segment.content}</Text>
              </Box>
            ) : (
              <Text key={index}>{segment.content}</Text>
            )
          )}
        </Box>
      );
    }
    case "plan_decision": {
      const approved = item.outcome !== "rejected";
      const accent = approved ? MODE_PLAN_FG : "gray";
      return (
        <Box
          flexDirection="column"
          alignSelf="flex-start"
          marginLeft={2}
          marginBottom={1}
          paddingX={1}
          borderStyle="round"
          borderColor={accent}
        >
          <Box>
            <Text bold color={accent}>
              {item.outcome === "approved-auto"
                ? "■ Plan approved — implementing in auto mode"
                : item.outcome === "approved-wait"
                  ? "■ Plan approved — awaiting your instructions"
                  : "□ Plan rejected"}
            </Text>
            {/* The saved path is the point of showing it: the plan can be
                reread, diffed or committed afterwards, which is only useful
                if you know where it went. */}
            {item.filePath ? (
              <Text dimColor> · {item.filePath}</Text>
            ) : (
              <Text dimColor>
                {" "}
                · not saved{approved ? " (write failed)" : ""}
              </Text>
            )}
          </Box>
          {item.comment && (
            <Text color={accent}>Your feedback: {item.comment}</Text>
          )}
        </Box>
      );
    }
    case "file_change":
      return (
        <Box
          flexDirection="column"
          alignSelf="flex-start"
          marginLeft={2}
          marginBottom={1}
          paddingX={1}
          borderStyle="classic"
          borderColor="gray"
        >
          <Text bold color={MANTU_PURPLE}>
            {item.originalContent === "" ? "Created" : "Modified"}{" "}
            {item.filePath}
          </Text>
          <DiffView
            originalContent={item.originalContent}
            updatedContent={item.updatedContent}
            filePath={item.filePath}
            maxLines={FILE_CHANGE_MAX_LINES}
          />
        </Box>
      );
    case "todo_list":
      return (
        <Box
          flexDirection="column"
          marginLeft={2}
          marginBottom={1}
          paddingX={1}
          borderStyle="classic"
          borderColor={MANTU_PURPLE}
        >
          {item.todos.map((todo, i) => {
            const marker =
              todo.status === "completed"
                ? "[x]"
                : todo.status === "in_progress"
                  ? "[~]"
                  : "[ ]";
            return (
              <Text
                key={i}
                color={todo.status === "completed" ? "gray" : undefined}
                dimColor={todo.status === "completed"}
              >
                {marker} {todo.content}
              </Text>
            );
          })}
        </Box>
      );
    case "separator":
      return <Box height={1}></Box>;
    default:
      assertNever(item);
  }
};

/**
 * Wraps the _Conversation component to fully rerender it when the terminal is resized.
 * This also clears the terminal before rendering.
 * This is needed to prevent artifacts when terminal's width shrinks.
 */
const Conversation: React.FC<ConversationProps> = (props) => {
  const [renderKey, setRenderKey] = useState(0);
  const { columns } = useTerminalSize();
  const initRenderKey = useRef(false);

  const handleResize = useCallback(() => {
    void clearTerminal().then(() => setRenderKey((k) => k + 1));
  }, []);

  const debouncedHandleResize = useMemo(
    () => _.debounce(handleResize, 100),
    [handleResize]
  );

  useEffect(() => {
    if (!initRenderKey.current) {
      initRenderKey.current = true;
      return;
    }

    debouncedHandleResize();
    return debouncedHandleResize.cancel;
  }, [debouncedHandleResize, columns]);

  return <_Conversation {...props} key={renderKey.toString()} />;
};

export default Conversation;
