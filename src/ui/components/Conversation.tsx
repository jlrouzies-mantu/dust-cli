import { assertNever } from "@dust-tt/client";
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
  CODE_BLOCK_BG,
  MANTU_AGENT_ACCENT,
  MANTU_GOLD,
  MANTU_PURPLE,
  MANTU_USER_ACCENT,
} from "../../utils/brand.js";
import type { ContextUsage } from "../../utils/contextUsage.js";
import type { CreditsUsage } from "../../utils/creditsInfo.js";
import type { MarkdownSegment } from "../../utils/markdown.js";
import { formatFileSize, isImageFile } from "../../utils/fileHandling.js";
import { getGitBranch } from "../../utils/gitInfo.js";
import { useTerminalSize } from "../../utils/hooks/use_terminal_size.js";
import { clearTerminal } from "../../utils/terminal.js";
import { CLI_VERSION } from "../../utils/version.js";
import type { Command } from "../commands/types.js";
import { CommandSelector } from "./CommandSelector.js";
import type { UploadedFile } from "./FileUpload.js";
import type { InlineSelectorItem } from "./InlineSelector.js";
import { InlineSelector } from "./InlineSelector.js";
import { InputBox } from "./InputBox.js";
import { ThinkingIcon } from "./ThinkingIcon.js";

function formatTokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatPercent(used: number, total: number): string {
  if (total <= 0) {
    return "0";
  }
  return ((used / total) * 100).toFixed(0);
}

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
      type: "agent_message_cancelled";
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
      type: "separator";
    }
);

interface ConversationProps {
  conversationItems: ConversationItem[];
  isProcessingQuestion: boolean;
  actionStatus: string | null;
  thinkingPreview: string;
  streamingContentPreview: MarkdownSegment[];
  showExitHint: boolean;
  agentName: string | null;
  workspaceName: string | null;
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
  autoAcceptEdits: boolean;
  inlineSelector?: {
    items: InlineSelectorItem[];
    query: string;
    selectedIndex: number;
    prompt?: string;
    header?: React.ReactNode;
  } | null;
}

const _Conversation: FC<ConversationProps> = ({
  conversationItems,
  isProcessingQuestion,
  actionStatus,
  thinkingPreview,
  streamingContentPreview,
  showExitHint,
  agentName,
  workspaceName,
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
  autoAcceptEdits,
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

      {isProcessingQuestion &&
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

      {isProcessingQuestion && (
        <Box marginTop={1}>
          {actionStatus ? (
            <Text color="yellow">
              {actionStatus}
              <Spinner type="simpleDots" />
            </Text>
          ) : (
            <Text color="green">
              {" "}
              <ThinkingIcon /> Thinking
              <Spinner type="simpleDots" />
              {thinkingPreview && (
                <Text dimColor italic>
                  {" "}
                  · {thinkingPreview}
                </Text>
              )}
            </Text>
          )}
        </Box>
      )}

      <InputBox
        userInput={showCommandSelector ? `/${commandQuery}` : userInput}
        cursorPosition={
          showCommandSelector ? commandCursorPosition + 1 : cursorPosition
        }
        isProcessingQuestion={isProcessingQuestion}
        mentionPrefix={mentionPrefix}
        autoAcceptEdits={autoAcceptEdits}
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
        />
      )}
      {showExitHint && (
        <Box paddingLeft={1}>
          <Text color="yellow">Press Ctrl+C again to exit</Text>
        </Box>
      )}
      {!showCommandSelector && !inlineSelector && (
        <Box marginTop={0} paddingLeft={1}>
          <Text dimColor>
            Enter to send · Ctrl+Enter or Shift+Enter for new line · Ctrl+W
            delete word · ESC to clear
            {conversationId && " · Ctrl+G to open in browser"}
          </Text>
        </Box>
      )}
      <Box paddingLeft={1}>
        <Text>
          {workspaceName && (
            <>
              <Text dimColor>{workspaceName}</Text>
              <Text dimColor>
                {" "}
                ·{" "}
              </Text>
            </>
          )}
          {agentName && (
            <>
              <Text bold color={MANTU_PURPLE}>
                @{agentName}
              </Text>
              <Text dimColor>
                {" "}
                ·{" "}
              </Text>
            </>
          )}
          <Text color={MANTU_GOLD}>{displayPath}</Text>
          {gitBranch && (
            <>
              <Text dimColor>
                {" "}
                ·{" "}
              </Text>
              <Text color={MANTU_PURPLE}>{gitBranch}</Text>
            </>
          )}
          {conversationId && (
            <>
              <Text dimColor>
                {" "}
                ·{" "}
              </Text>
              <Text dimColor>{conversationId.slice(0, 8)}</Text>
            </>
          )}
          {contextUsage && (
            <>
              <Text dimColor>
                {" "}
                ·{" "}
              </Text>
              <Text color={MANTU_PURPLE}>
                {formatTokenCount(contextUsage.contextUsage)}/
                {formatTokenCount(contextUsage.contextSize)} (
                {formatPercent(
                  contextUsage.contextUsage,
                  contextUsage.contextSize
                )}
                %) context
              </Text>
            </>
          )}
          {consumedCredits !== null && (
            <>
              <Text dimColor>
                {" "}
                ·{" "}
              </Text>
              <Text color={MANTU_GOLD}>
                {consumedCredits.consumed}
                {consumedCredits.limit !== null &&
                  `/${consumedCredits.limit}`}
                {consumedCredits.limit !== null &&
                  ` (${formatPercent(
                    consumedCredits.consumed,
                    consumedCredits.limit
                  )}%)`}{" "}
                credits used
              </Text>
            </>
          )}
        </Text>
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
              <Text color={MANTU_GOLD}>
                Report bug here: https://github.com/jlrouzies-mantu/dust-cli
              </Text>
              <Text dimColor>
                Dust CLI v{CLI_VERSION} · {displayPath}
                {gitBranch && ` · branch: ${gitBranch}`}
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
          <Text color="red">[Cancelled]</Text>
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
