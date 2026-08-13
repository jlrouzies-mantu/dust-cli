import type {
  AgentActionSpecificEvent,
  ConversationPublicType,
  CreateConversationResponseType,
  DustAPI,
  GetAgentConfigurationsResponseType,
} from "@dust-tt/client";
import { readdir, stat } from "fs/promises";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import Spinner from "ink-spinner";
import open from "open";
import path from "path";
import type { FC } from "react";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { useFileSystemServer } from "../../mcp/servers/fsServer.js";
import type { TodoItem } from "../../mcp/tools/todoWrite.js";
import { todoListEmitter } from "../../mcp/tools/todoWrite.js";
import AuthService from "../../utils/authService.js";
import { MANTU_THINKING_PINK } from "../../utils/brand.js";
import type { ChatMode } from "../../utils/chatMode.js";
import {
  chatModeLabel,
  describeChatMode,
  isAutoAcceptMode,
  isPlanMode,
  nextChatMode,
} from "../../utils/chatMode.js";
import type { ClaudeContext } from "../../utils/claudeMemory.js";
import {
  buildPrimingBlock,
  hasAnyContext,
  loadClaudeContext,
  summarizeContext,
} from "../../utils/claudeMemory.js";
import { getClipboardImagePath } from "../../utils/clipboardImage.js";
import type { ContextUsage } from "../../utils/contextUsage.js";
import { getContextUsage } from "../../utils/contextUsage.js";
import type { CreditsUsage } from "../../utils/creditsInfo.js";
import { getConsumedCredits } from "../../utils/creditsInfo.js";
import { getDustClient } from "../../utils/dustClient.js";
import { normalizeError } from "../../utils/errors.js";
import type { PlanDecision } from "../../utils/planMode.js";
import {
  PLAN_MODE_BLOCKED_TOOLS,
  planModePreamble,
  planModeReminder,
  setPlanMode,
} from "../../utils/planMode.js";
import { saveApprovedPlan } from "../../utils/planStore.js";
import type { LoopState } from "../../utils/loopController.js";
import {
  describeLoop,
  formatInterval,
  parseLoopCommand,
} from "../../utils/loopController.js";
import type { FileInfo } from "../../utils/fileHandling.js";
import {
  formatFileSize,
  getFileExtension,
  isImageFile,
  isSupportedFileType,
  validateAndGetFileInfo,
} from "../../utils/fileHandling.js";
import { useAgents } from "../../utils/hooks/use_agents.js";
import { useMe } from "../../utils/hooks/use_me.js";
import type { MarkdownSegment } from "../../utils/markdown.js";
import { renderMarkdownSegments } from "../../utils/markdown.js";
import { retryResult } from "../../utils/retry.js";
import {
  clearTerminal,
  clearTerminalAndScrollback,
} from "../../utils/terminal.js";
import { toolsCache } from "../../utils/toolsCache.js";
import { appendTranscriptEntry } from "../../utils/transcriptStore.js";
import AgentSelector from "../components/AgentSelector.js";
import type { ConversationItem } from "../components/Conversation.js";
import Conversation from "../components/Conversation.js";
import { DiffView } from "../components/DiffView.js";
import type { DiffContent } from "../components/DiffView.js";
import type { UploadedFile } from "../components/FileUpload.js";
import { FileUpload } from "../components/FileUpload.js";
import type { InlineSelectorItem } from "../components/InlineSelector.js";
import { ThinkingIcon } from "../components/ThinkingIcon.js";
import { resolveSpaceId, validateProjectFlags } from "./chat/nonInteractive.js";
import { createCommands, splitCommandQuery } from "./types.js";

type AgentConfiguration =
  GetAgentConfigurationsResponseType["agentConfigurations"][number];

interface QueuedMessage {
  id: string;
  text: string;
  files: UploadedFile[];
  // Steered messages (Ctrl+S) genuinely interrupt the current turn and are
  // sent next; this just tracks that for display, so the UI can show them
  // in their own "Steered" block, separate from plain queued ones.
  steered: boolean;
  // Set on messages a /loop tick enqueued, so the next tick can tell whether
  // its predecessor has actually been sent yet (see loopBusyRef).
  loop?: boolean;
}

interface CliChatProps {
  sId?: string;
  agentSearch?: string;
  conversationId?: string;
  autoAcceptEditsFlag?: boolean;
  planModeFlag?: boolean;
  projectName?: string;
  projectId?: string;
}

// Pastes with more lines than this get collapsed to a placeholder in the
// input box instead of dumping the raw text inline.
const PASTE_COMPACT_LINE_THRESHOLD = 4;

// Raw escape sequences for Home/End, across the terminal variants that send
// different ones (xterm vs. legacy VT vs. application-cursor-mode) - see
// lastRawSequenceRef above for why these have to be matched by hand.
const HOME_KEY_SEQUENCES = new Set([
  "\x1b[H",
  "\x1b[1~",
  "\x1b[7~",
  "\x1bOH",
]);
const END_KEY_SEQUENCES = new Set(["\x1b[F", "\x1b[4~", "\x1b[8~", "\x1bOF"]);

// See clipboardImage.ts - Windows is tested, macOS is best-effort/unverified.
const SUPPORTS_CLIPBOARD_IMAGE =
  process.platform === "win32" || process.platform === "darwin";

function getLastConversationItem<T extends ConversationItem>(
  items: ConversationItem[],
  type: T["type"]
): T | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === type) {
      return item as T;
    }
  }
  return null;
}

// The live streaming preview re-renders the *entire* accumulated answer on
// every tick (see the comment on pushFinalContentToConversationItems for
// why it can't incrementally commit to the Static list instead). Every one
// of those re-renders is new output from the terminal's point of view, so
// it auto-scrolls to reveal it - which is what fights back when you try to
// scroll up to read earlier output while a long answer is still streaming.
// A big live region makes each of those forced scrolls jarring; keeping it
// to just a handful of lines (about the same footprint as the "Thinking"
// spinner, which doesn't cause this complaint) keeps each one small enough
// to not fight your own scrolling. The full untruncated content still
// lands in scrollback normally once the message finishes.
const STREAMING_PREVIEW_MAX_LINES = 6;
function truncateForStreamingPreview(text: string): string {
  const maxLines = STREAMING_PREVIEW_MAX_LINES;
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return text;
  }
  return `…\n${lines.slice(-maxLines).join("\n")}`;
}

// Matches the "[Pasted N lines of text]" placeholder a large paste gets
// collapsed to in the input (see pastedBlocksRef usage below). The real
// content behind it only ever lives transiently in pastedBlocksRef,
// consumed the moment it's actually sent - conversationItems' stored
// `content` keeps the placeholder text forever, so a message containing
// one can't be meaningfully resent from history navigation (it would just
// submit the literal placeholder string, not the original paste).
const PASTE_PLACEHOLDER_RE = /\[Pasted \d+ lines? of text\]/;

// Steering cancels the in-flight turn server-side, which wipes any
// in-progress text reply (confirmed by direct testing - completed tool
// results survive on their own, but free text doesn't). This re-supplies
// that lost text as context in the follow-up message, so the agent can
// pick up where it left off if the steer message doesn't say otherwise.
function buildSteerRedirectPrompt(
  originalTask: string,
  partialContent: string,
  steerMessage: string
): string {
  const trimmedPartial = partialContent.trim();
  const partialSection = trimmedPartial
    ? `\nYou had already written this much of your reply before being cut off (not saved - shown only for context):\n\n"""\n${trimmedPartial}\n"""\n`
    : "";
  return (
    `[Automated note, not from the user: your previous response was interrupted before it finished - including any tool calls in progress, which did not complete.]\n\n` +
    `The user interrupted you to say:\n\n"""\n${steerMessage}\n"""\n\n` +
    `The task you were working on when interrupted was:\n\n"""\n${originalTask}\n"""\n` +
    partialSection +
    `\nHow to proceed, in this order:\n` +
    `1. Respond to the user's interrupting message above. Always address it explicitly - never skip it or reply with an empty/placeholder line, even if it seems trivial or unrelated to the task.\n` +
    `2. Then resume and complete the original task, unless the interruption told you to stop, cancel, or abandon it. Being interrupted does not by itself mean the task was cancelled. If the interruption was a correction, clarification, or change of direction for that task, fold it in and continue accordingly.`
  );
}

function buildConversationItemsFromHistory(
  conv: ConversationPublicType,
  agent: { name: string; description: string }
): ConversationItem[] {
  const items: ConversationItem[] = [
    {
      key: "welcome_header",
      type: "welcome_header",
      agentName: agent.name,
      agentDescription: agent.description,
    },
  ];

  let userMsgIdx = 0;
  let agentMsgIdx = 0;

  for (const messageGroup of conv.content) {
    for (const msg of messageGroup) {
      if (msg.type === "user_message") {
        items.push({
          key: `resumed_user_${userMsgIdx}`,
          type: "user_message",
          firstName: msg.user?.firstName ?? "You",
          content: msg.content,
          index: userMsgIdx,
        });
        userMsgIdx++;
      } else if (msg.type === "agent_message") {
        items.push({
          key: `resumed_agent_header_${agentMsgIdx}`,
          type: "agent_message_header",
          agentName: msg.configuration.name,
          index: agentMsgIdx,
        });
        if (msg.content) {
          const segments = renderMarkdownSegments(msg.content.trim());
          segments.forEach((segment, segmentIdx) => {
            items.push(
              segment.type === "code"
                ? {
                    key: `resumed_agent_code_${agentMsgIdx}_${segmentIdx}`,
                    type: "agent_message_code_block",
                    text: segment.content,
                    index: agentMsgIdx,
                  }
                : {
                    key: `resumed_agent_text_${agentMsgIdx}_${segmentIdx}`,
                    type: "agent_message_text_segment",
                    text: segment.content,
                    index: agentMsgIdx,
                  }
            );
          });
        }
        items.push({
          key: `resumed_agent_sep_${agentMsgIdx}`,
          type: "separator",
        });
        agentMsgIdx++;
      }
    }
  }

  return items;
}

const CliChat: FC<CliChatProps> = ({
  sId: requestedAgentId,
  agentSearch,
  conversationId,
  autoAcceptEditsFlag,
  planModeFlag,
  projectName,
  projectId,
}) => {
  // One tri-state permission mode cycled with Shift+Tab, rather than separate
  // auto-accept and plan flags - see utils/chatMode.ts for why they can't
  // both be on. `/auto` and `/plan` set it directly.
  const [chatMode, setChatMode] = useState<ChatMode>(
    planModeFlag ? "plan" : autoAcceptEditsFlag ? "auto" : "normal"
  );
  const autoAcceptEdits = isAutoAcceptMode(chatMode);
  const autoAcceptEditsRef = useRef(autoAcceptEdits);
  const chatModeRef = useRef(chatMode);

  // /claude-code-mode: whether the agent gets primed with the user's Claude
  // Code memories. `claudeContextRef` holds the loaded context so it can be
  // re-primed after /new without re-reading the disk, and
  // `pendingClaudePrimingRef` is the "not yet sent on this conversation"
  // latch - see toggleClaudeCodeMode for why priming rides along with the
  // next message rather than being sent as one of its own.
  const [claudeCodeMode, setClaudeCodeMode] = useState(false);
  const claudeContextRef = useRef<ClaudeContext | null>(null);
  const pendingClaudePrimingRef = useRef(false);
  const claudeCodeModeRef = useRef(false);

  // /loop: re-sends one prompt on an interval. `loopRef` mirrors the state
  // for the interval callback (a setInterval closure would otherwise capture
  // the value from the render that armed it), and `loopBusyRef` mirrors
  // "a turn is in flight or a loop message is still queued", which is what
  // makes a tick skip instead of stack.
  const [loop, setLoop] = useState<LoopState | null>(null);
  const loopRef = useRef<LoopState | null>(null);
  const loopBusyRef = useRef(false);

  const [error, setError] = useState<string | null>(null);

  const [selectedAgent, setSelectedAgent] = useState<AgentConfiguration | null>(
    null
  );
  const [isProcessingQuestion, setIsProcessingQuestion] = useState(false);
  // True from the moment Esc/Ctrl+C asks the server to cancel until the
  // turn actually ends - cancelMessageGeneration is a real round trip
  // (confirmed by testing: it isn't instant), and without this the
  // "Thinking"/tool-status line just sits there for a couple of seconds
  // looking like the keypress didn't register at all.
  const [isCancelling, setIsCancelling] = useState(false);
  // Reset alongside isProcessingQuestion rather than at every place that
  // sets it false (agent_generation_cancelled, the aborted catch branch,
  // agent_message_success, error paths, ...) - "the turn is over" already
  // has one source of truth, and isCancelling only ever means "waiting on
  // that to happen".
  useEffect(() => {
    if (!isProcessingQuestion) {
      setIsCancelling(false);
    }
  }, [isProcessingQuestion]);
  const [currentConversationId, setCurrentConversationId] = useState<
    string | null
  >(conversationId ? conversationId : null);
  const [conversationItems, setConversationItems] = useState<
    ConversationItem[]
  >([]);
  const [abortController, setAbortController] =
    useState<AbortController | null>(null);
  const [userInput, setUserInput] = useState("");
  const [cursorPosition, setCursorPosition] = useState(0);
  // Position within this conversation's own sent messages while navigating
  // history with Up/Down (null = not currently navigating; otherwise an
  // index into the oldest-first user_message list, counting backward from
  // the end). Reset whenever the input is cleared by an actual send/cancel
  // rather than by history navigation itself.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  // Bumped after every manual clearTerminal() call (new/resumed
  // conversation) and used as the <Conversation> element's React `key` -
  // clearTerminal() writes raw ANSI codes directly to stdout, bypassing
  // Ink's own render bookkeeping entirely. Without a full remount
  // afterward, Ink's next render thinks the cursor/previous-frame-height
  // are wherever they were before the clear, not the top of a blank
  // screen, and ends up leaving the old input box/status bar behind
  // instead of cleanly replacing them - the exact same class of artifact
  // Conversation.tsx already works around for terminal *resizes*, just not
  // wired up for this case.
  const [conversationRenderKey, setConversationRenderKey] = useState(0);
  const [showCommandSelector, setShowCommandSelector] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [commandCursorPosition, setCommandCursorPosition] = useState(0);
  const [inlineSelector, setInlineSelector] = useState<{
    mode:
      | "agent"
      | "file"
      | "conversation"
      | "approval"
      | "diff"
      | "plan"
      | "mention";
    items: InlineSelectorItem[];
    query: string;
    selectedIndex: number;
    currentPath?: string;
    // Position in `userInput` where the "@" that opened this selector sits -
    // mention mode never edits `userInput` while it's open (typing goes into
    // `query`, same as the other filterable modes), so this is where the
    // chosen path gets spliced back in on selection.
    mentionAnchor?: number;
  } | null>(null);
  const [pendingApproval, setPendingApproval] =
    useState<AgentActionSpecificEvent | null>(null);
  const [approvalResolver, setApprovalResolver] = useState<
    ((approved: boolean) => void) | null
  >(null);
  const [pendingDiffApproval, setPendingDiffApproval] = useState<{
    originalContent: string;
    updatedContent: string;
    filePath: string;
  } | null>(null);
  const [diffApprovalResolver, setDiffApprovalResolver] = useState<
    ((approved: boolean) => void) | null
  >(null);
  // The plan awaiting approval (markdown), and the resolver that hands the
  // decision back to the present_plan tool call still waiting on it.
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  const [planApprovalResolver, setPlanApprovalResolver] = useState<
    ((decision: PlanDecision) => void) | null
  >(null);
  // Set while "Reject with a comment" is collecting that comment through the
  // normal input box, with the present_plan call still awaiting an answer.
  const [awaitingPlanComment, setAwaitingPlanComment] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<FileInfo[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [fileSystemInitialized, setFileSystemInitialized] = useState(false);
  const [fileSystemServerId, setFileSystemServerId] = useState<string | null>(
    null
  );
  const [resolvedSpaceId, setResolvedSpaceId] = useState<string | undefined>(
    undefined
  );
  const [isResolvingSpace, setIsResolvingSpace] = useState(
    !!(projectName || projectId)
  );
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [thinkingPreview, setThinkingPreview] = useState("");
  const [streamingContentPreview, setStreamingContentPreview] = useState<
    MarkdownSegment[]
  >([]);
  const [showExitHint, setShowExitHint] = useState(false);
  // Surfaces retryResult()'s retry attempts (API/MCP calls) in the UI -
  // otherwise they only show up in the debug log, indistinguishable from
  // "it didn't retry at all" from the user's perspective.
  const [retryStatus, setRetryStatus] = useState<string | null>(null);
  // A brief, self-clearing status line (unlike pushNotice, which appends
  // permanently to scrollback) - for feedback on a key press that's routine
  // to repeat (e.g. Ctrl+S pressed before typing anything), so mashing it
  // doesn't flood the transcript with duplicate lines forever.
  const [transientHint, setTransientHint] = useState<string | null>(null);
  const transientHintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [consumedCredits, setConsumedCredits] = useState<CreditsUsage | null>(
    null
  );
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  // These undocumented endpoints occasionally return null on a transient
  // hiccup (see creditsInfo.ts/contextUsage.ts) - once we've displayed a
  // real value in the status bar, a later failed refresh shouldn't blank
  // it back out, so only apply updates that actually carry a value.
  const setContextUsageIfPresent = useCallback((usage: ContextUsage | null) => {
    if (usage !== null) {
      setContextUsage(usage);
    }
  }, []);
  const setConsumedCreditsIfPresent = useCallback(
    (usage: CreditsUsage | null) => {
      if (usage !== null) {
        setConsumedCredits(usage);
      }
    },
    []
  );
  const updateIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const contentRef = useRef<string>("");
  const chainOfThoughtRef = useRef<string>("");
  // Real server-side cancellation (cancelMessageGeneration) support: enough
  // state to call it against the right conversation/message, and to know
  // whether a tool call is currently in flight so a steer request can wait
  // for it to finish rather than interrupting it mid-flight (completed tool
  // results survive cancellation; a mid-flight one is untested and assumed
  // risky - see README's steering note).
  const activeDustClientRef = useRef<DustAPI | null>(null);
  const activeConversationIdRef = useRef<string | null>(null);
  const agentMessageIdRef = useRef<string | null>(null);
  const toolCallInFlightRef = useRef(false);
  // Set when a steer was requested mid-tool-call: the message is already
  // queued (so it shows immediately), but the interrupt itself waits for
  // the running call to finish.
  const steerCancelPendingRef = useRef(false);
  const pendingSteerContextRef = useRef<{ partialContent: string } | null>(
    null
  );
  // The current turn's original task text, so a steer redirect can remind
  // the agent what it was working on - without this, a steer whose text
  // reads as a standalone question (e.g. "what is 1+1") gets answered and
  // the original task is simply dropped, since nothing else in the
  // redirect message says what that task even was.
  const currentTurnPromptRef = useRef<string>("");
  const resumeLoadedRef = useRef(false);
  const todoListIndexRef = useRef(0);
  // Timestamp of the previous useInput event, used to detect pasted text
  // arriving as a rapid sequence of individual keystrokes (see the
  // key.return handling below).
  const lastKeystrokeTimeRef = useRef(0);
  // Large pastes are shown in the input as a compact "[Pasted N lines of
  // text]" placeholder instead of the raw content (matching Claude Code),
  // with the real content kept here and swapped back in at submit time -
  // see the input.length > 1 paste-handling branch below.
  const pastedBlocksRef = useRef<{ placeholder: string; content: string }[]>(
    []
  );
  const lastCtrlCTimeRef = useRef(0);
  const exitHintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const { stdout } = useStdout();
  const { exit } = useApp();

  const { me, isLoading: isMeLoading, error: meError } = useMe();

  // Resolve the active workspace's name for the persistent status bar.
  useEffect(() => {
    if (!me || workspaceName) {
      return;
    }
    void (async () => {
      const workspaceId = await AuthService.getSelectedWorkspaceId();
      const workspace = me.workspaces.find((w) => w.sId === workspaceId);
      if (workspace) {
        setWorkspaceName(workspace.name);
      }
    })();
  }, [me, workspaceName]);

  // Kicked off on mount rather than gated behind `me` loading - unlike the
  // workspace name above, this fetches its own access token/workspace ID
  // directly via AuthService, so it doesn't need to wait on the separate
  // useMe() round-trip. Every bit of head start here matters: if a user
  // sends their first message before this resolves, the status bar just
  // won't have a value to show yet for that first reply.
  useEffect(() => {
    void getConsumedCredits().then(setConsumedCreditsIfPresent);
  }, [setConsumedCreditsIfPresent]);

  // The todo_write tool call runs inside the MCP transport layer, not this
  // React tree - subscribe to its emitter to render each snapshot as a new
  // conversation item (Static is append-only, so each update is a fresh
  // item, same as how Claude Code prints a new checklist snapshot per call).
  useEffect(() => {
    const handleTodoUpdate = (todos: TodoItem[]) => {
      const index = todoListIndexRef.current++;
      setConversationItems((prev) => [
        ...prev,
        {
          key: `todo_list_${index}`,
          type: "todo_list",
          todos,
          index,
        },
      ]);
    };
    todoListEmitter.on("update", handleTodoUpdate);
    return () => {
      todoListEmitter.off("update", handleTodoUpdate);
    };
  }, []);

  // Import useAgents hook for agent search functionality
  const {
    allAgents,
    error: agentsError,
    isLoading: agentsIsLoading,
  } = useAgents();

  // Validate and resolve spaceId from projectName or projectId
  useEffect(() => {
    // Validate flags first - fail fast before any async operations
    const validationError = validateProjectFlags(
      projectName,
      projectId,
      conversationId ?? undefined
    );
    if (validationError) {
      setError(validationError);
      setIsResolvingSpace(false);
      return;
    }

    if (!projectName && !projectId) {
      setIsResolvingSpace(false);
      return;
    }

    async function resolveSpace() {
      const dustClientRes = await getDustClient();
      if (dustClientRes.isErr()) {
        setError(dustClientRes.error.message);
        setIsResolvingSpace(false);
        return;
      }

      const dustClient = dustClientRes.value;
      if (!dustClient) {
        setError("Authentication required. Run `dustm login` first.");
        setIsResolvingSpace(false);
        return;
      }

      try {
        const spaceId = await resolveSpaceId(
          dustClient,
          projectName,
          projectId
        );
        setResolvedSpaceId(spaceId);
      } catch (error) {
        setError(normalizeError(error).message);
      } finally {
        setIsResolvingSpace(false);
      }
    }

    void resolveSpace();
  }, [projectName, projectId, conversationId]);

  // Lightweight, non-fatal inline notice appended to the transcript - unlike
  // setError, which renders a full-screen "Press Ctrl+C to exit" box that
  // replaces the whole chat UI. Reserve setError for genuinely unrecoverable
  // failures; use this for routine, retryable notices (e.g. "no image on
  // the clipboard").
  const pushNotice = useCallback((text: string) => {
    setConversationItems((prev) => [
      ...prev,
      {
        key: `notice_${Date.now()}`,
        type: "agent_message_content_line",
        text,
        index: 0,
      },
    ]);
  }, []);

  // Marks where a turn stopped early in the transcript - distinguishing a
  // steer (the agent was redirected, and the follow-up message right below
  // continues the thread) from a plain Esc/Ctrl+C cancel (the user just
  // wanted it to stop), since those read very differently in scrollback.
  const appendCancellationMarker = useCallback((steered: boolean) => {
    setConversationItems((prev) => {
      const lastAgentMessageHeader = getLastConversationItem<
        ConversationItem & { type: "agent_message_header" }
      >(prev, "agent_message_header");
      const index = lastAgentMessageHeader?.index ?? 0;
      return [
        ...prev,
        {
          key: `agent_message_cancelled_${index}_${Date.now()}`,
          type: "agent_message_cancelled",
          steered,
        },
      ];
    });
  }, []);

  const showTransientHint = useCallback((text: string) => {
    setTransientHint(text);
    if (transientHintTimeoutRef.current) {
      clearTimeout(transientHintTimeoutRef.current);
    }
    transientHintTimeoutRef.current = setTimeout(() => {
      setTransientHint(null);
    }, 2500);
  }, []);

  // Actually stops the current turn server-side via cancelMessageGeneration
  // - unlike a bare AbortController.abort(), which only disconnects this
  // client's stream reader and leaves the agent running (and burning
  // credits/tool calls) in the background, as confirmed by direct testing
  // against the API (see README's steering note). Falls back to a local
  // abort only if we don't have an agent message id yet (interrupted before
  // any stream event arrived) or the cancel call itself fails - that alone
  // can't stop server-side work, but it at least stops the UI from hanging.
  const cancelCurrentGeneration = useCallback(async () => {
    const dustClient = activeDustClientRef.current;
    const conversationId = activeConversationIdRef.current;
    const agentMessageId = agentMessageIdRef.current;
    if (dustClient && conversationId && agentMessageId) {
      const res = await dustClient.cancelMessageGeneration({
        conversationId,
        messageIds: [agentMessageId],
      });
      if (!res.isErr()) {
        // The server emits `agent_generation_cancelled` on the existing
        // stream shortly after this succeeds - the already-handled event
        // finishes the turn naturally; disconnecting the client too would
        // just race it.
        return;
      }
    }
    abortController?.abort();
  }, [abortController]);

  // Fires the interrupt for a steer request that was held while a tool
  // call was in flight, now that the call has safely completed - the
  // message itself was already queued when the key was pressed, so only
  // the cancellation is left to do here.
  const flushPendingSteer = useCallback(() => {
    if (!steerCancelPendingRef.current) {
      return;
    }
    steerCancelPendingRef.current = false;
    pendingSteerContextRef.current = { partialContent: contentRef.current };
    void cancelCurrentGeneration();
  }, [cancelCurrentGeneration]);

  const triggerAgentSwitch = useCallback(() => {
    // Clear all input states before switching.
    setUserInput("");
    setCursorPosition(0);
    setShowCommandSelector(false);
    setCommandQuery("");
    setSelectedCommandIndex(0);
    setCommandCursorPosition(0);

    const items: InlineSelectorItem[] = (allAgents || []).map((agent) => ({
      id: agent.sId,
      label: agent.name,
      description: agent.description.split("\n")[0]?.slice(0, 60) || "",
    }));

    setInlineSelector({
      mode: "agent",
      items,
      query: "",
      selectedIndex: 0,
    });
  }, [allAgents]);

  const loadDirectoryItems = useCallback(
    async (dirPath: string): Promise<InlineSelectorItem[]> => {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const items: InlineSelectorItem[] = [];

      // Clipboard image paste has no terminal-level "paste" event to hook
      // into (a real OS paste only ever delivers text over stdin), so it's
      // offered here as a selectable entry instead. See clipboardImage.ts.
      if (SUPPORTS_CLIPBOARD_IMAGE) {
        items.push({
          id: "__clipboard__",
          label: "📋 Paste image from clipboard",
        });
      }

      // Add parent directory navigation unless at root
      if (dirPath !== "/") {
        items.push({ id: path.dirname(dirPath), label: ".." });
      }

      const dirs: InlineSelectorItem[] = [];
      const supportedFiles: InlineSelectorItem[] = [];
      const unsupportedFiles: InlineSelectorItem[] = [];

      for (const entry of entries) {
        // Skip hidden files/dirs
        if (entry.name.startsWith(".")) {
          continue;
        }

        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          dirs.push({ id: fullPath, label: `📁 ${entry.name}/` });
        } else if (entry.isFile()) {
          const ext = getFileExtension(entry.name);
          if (isSupportedFileType(ext)) {
            supportedFiles.push({ id: fullPath, label: `  ${entry.name}` });
          } else {
            unsupportedFiles.push({
              id: fullPath,
              label: `  ${entry.name}`,
              description: "(unsupported)",
            });
          }
        }
      }

      // Directories first, then supported files, then unsupported
      items.push(...dirs, ...supportedFiles, ...unsupportedFiles);

      // Cap at 200 items
      const MAX_ITEMS = 200;
      if (items.length > MAX_ITEMS) {
        const remaining = items.length - MAX_ITEMS;
        const capped = items.slice(0, MAX_ITEMS);
        capped.push({
          id: "__more__",
          label: `(${remaining} more items not shown)`,
        });
        return capped;
      }

      return items;
    },
    []
  );

  // Flat, recursive file listing for "@" mentions (see the mention trigger
  // below) - unlike loadDirectoryItems, which browses one folder at a time
  // for /attach, a mention is meant to be typed-and-filtered against the
  // whole project in one go. Cached for the life of the session: the cwd
  // doesn't change mid-session, and re-walking the tree on every "@" would
  // make the popup feel laggy on a large repo.
  const mentionFilesCacheRef = useRef<InlineSelectorItem[] | null>(null);
  const loadMentionFiles = useCallback(async (): Promise<
    InlineSelectorItem[]
  > => {
    if (mentionFilesCacheRef.current) {
      return mentionFilesCacheRef.current;
    }
    const { glob } = await import("glob");
    const matches = await glob("**/*", {
      cwd: process.cwd(),
      nodir: true,
      dot: false,
      ignore: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
        "**/.next/**",
        "**/coverage/**",
      ],
    });
    const items: InlineSelectorItem[] = matches
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
      .slice(0, 2000)
      .map((relativePath) => ({ id: relativePath, label: relativePath }));
    mentionFilesCacheRef.current = items;
    return items;
  }, []);

  // The approval prompt lives in Ink's non-static output, and once that
  // region reaches the terminal height Ink switches from incremental updates
  // to clearing the whole terminal and reprinting the entire transcript
  // every render - which reads as violent full-screen flicker. Tool inputs
  // are arbitrarily large (write_file's `content`, for one), so both the
  // number of lines and each line's length are bounded here: an over-long
  // single line still wraps into many rows, so truncating line count alone
  // wouldn't be enough.
  const APPROVAL_INPUT_MAX_LINES = 8;
  const formatInputs = (inputs: unknown): string => {
    if (!inputs) {
      return "";
    }
    const maxLineLength = Math.max(40, (stdout?.columns ?? 80) - 8);
    const clampLine = (line: string) =>
      line.length > maxLineLength
        ? `${line.slice(0, maxLineLength - 1)}…`
        : line;
    const clampBlock = (text: string) => {
      const lines = text.split("\n");
      const shown = lines.slice(0, APPROVAL_INPUT_MAX_LINES).map(clampLine);
      const hidden = lines.length - shown.length;
      return hidden > 0
        ? [...shown, `… ${hidden} more line${hidden === 1 ? "" : "s"}`].join(
            "\n"
          )
        : shown.join("\n");
    };

    if (typeof inputs === "string") {
      return clampBlock(inputs);
    }
    if (typeof inputs === "object" && !Array.isArray(inputs)) {
      return clampBlock(
        Object.entries(inputs as Record<string, unknown>)
          .map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
          .join("\n")
      );
    }
    return clampBlock(JSON.stringify(inputs, null, 2));
  };

  // Records an approved file write/edit permanently in the transcript
  // (Static list), so it stays visible in scrollback after the response
  // finishes - unlike the ephemeral approval-prompt preview, which is
  // cleared as soon as the user (or auto-accept) decides.
  const appendFileChangeItem = useCallback((diff: DiffContent) => {
    setConversationItems((prev) => [
      ...prev,
      {
        key: `file_change_${Date.now()}_${prev.length}`,
        type: "file_change",
        ...diff,
      },
    ]);
  }, []);

  const handleApprovalRequest = useCallback(
    async (event: AgentActionSpecificEvent): Promise<boolean> => {
      if (event.type !== "tool_approve_execution") {
        return false;
      }

      // Plan mode short-circuit, checked before anything else.
      //
      // This prompt is Dust's own server-side tool-approval step, which fires
      // *before* the tool runs and knows nothing about plan mode. Without this
      // branch, asking the agent to do something while planning means being
      // prompted to approve a write that our own gate is then guaranteed to
      // refuse - which reads as plan mode not working at all.
      //
      // Returning true here looks backwards but is deliberate: it lets the call
      // reach the tool, whose refusal explains plan mode and points at
      // present_plan (see planModeRefusal). Returning false would abort it with
      // a bare "rejected by user", teaching the agent nothing and leaving it to
      // guess why.
      if (
        isPlanMode(chatModeRef.current) &&
        (PLAN_MODE_BLOCKED_TOOLS as readonly string[]).includes(
          event.metadata.toolName
        )
      ) {
        return true;
      }

      // Auto-approve if stake is never_ask
      if (event.stake === "never_ask") {
        return true;
      }

      // For low stake tools, check cache first
      if (event.stake === "low") {
        const cachedApproval = await toolsCache.getCachedApproval({
          mcpServerName: event.metadata.mcpServerName,
          toolName: event.metadata.toolName,
        });

        if (cachedApproval !== null) {
          return cachedApproval;
        }
      }

      // For low/high stake, prompt user for approval
      return new Promise<boolean>((resolve) => {
        setPendingApproval(event);
        setApprovalResolver(() => resolve);

        const isLowStake = event.stake === "low";
        const items: InlineSelectorItem[] = isLowStake
          ? [
              { id: "approve", label: "Approve" },
              {
                id: "approve_and_cache",
                label: "Approve and don't ask again",
              },
              { id: "reject", label: "Reject" },
            ]
          : [
              { id: "approve", label: "Approve" },
              { id: "reject", label: "Reject" },
            ];

        setInlineSelector({
          mode: "approval",
          items,
          query: "",
          selectedIndex: 0,
        });
      });
    },
    []
  );

  const handleApproval = useCallback(
    async (approved: boolean, cacheApproval?: boolean) => {
      if (approvalResolver && pendingApproval) {
        if (pendingApproval.type !== "tool_approve_execution") {
          console.error(
            "Unexpected event type for approval handling:",
            pendingApproval.type
          );
          approvalResolver(false);
          setPendingApproval(null);
          setApprovalResolver(null);
          return;
        }
        // Cache the approval if requested and it's a low stake tool
        if (cacheApproval && pendingApproval.stake === "low") {
          await toolsCache.setCachedApproval({
            mcpServerName: pendingApproval.metadata.mcpServerName,
            toolName: pendingApproval.metadata.toolName,
          });
        }

        approvalResolver(approved);
        setPendingApproval(null);
        setApprovalResolver(null);
        setInlineSelector(null);
      }
    },
    [approvalResolver, pendingApproval]
  );

  const handleDiffApproval = useCallback(
    async (approved: boolean) => {
      if (diffApprovalResolver && pendingDiffApproval) {
        if (approved) {
          appendFileChangeItem(pendingDiffApproval);
        }
        diffApprovalResolver(approved);
        setPendingDiffApproval(null);
        setDiffApprovalResolver(null);
        setInlineSelector(null);
      }
    },
    [diffApprovalResolver, pendingDiffApproval, appendFileChangeItem]
  );

  const requestDiffApproval = useCallback(
    async (
      originalContent: string,
      updatedContent: string,
      filePath: string
    ): Promise<boolean> => {
      // If always accept flag is set, immediately return true - but still
      // record the change in the transcript, same as the interactive path.
      if (autoAcceptEditsRef.current) {
        appendFileChangeItem({ originalContent, updatedContent, filePath });
        return Promise.resolve(true);
      }

      return new Promise<boolean>((resolve) => {
        setPendingDiffApproval({ originalContent, updatedContent, filePath });
        setDiffApprovalResolver(() => (approved: boolean) => {
          resolve(approved);
        });

        setInlineSelector({
          mode: "diff",
          items: [
            { id: "accept", label: "Accept" },
            { id: "reject", label: "Reject" },
          ],
          query: "",
          selectedIndex: 0,
        });
      });
    },
    [appendFileChangeItem]
  );

  const clearFiles = useCallback(() => {
    setUploadedFiles([]);
    setPendingFiles([]);
    setIsUploadingFiles(false);
  }, []);

  const showAttachDialog = useCallback(async () => {
    const cwd = process.cwd();
    const items = await loadDirectoryItems(cwd);

    setUserInput("");
    setCursorPosition(0);
    setShowCommandSelector(false);
    setCommandQuery("");
    setSelectedCommandIndex(0);
    setCommandCursorPosition(0);

    setInlineSelector({
      mode: "file",
      items,
      query: "",
      selectedIndex: 0,
      currentPath: cwd,
    });
  }, [loadDirectoryItems]);

  // Pushes plain lines + a separator into permanent scrollback, the same
  // shape /help and /resume's empty state use for CLI-side (non-agent)
  // output.
  const pushNoticeLines = useCallback((lines: string[], keyPrefix: string) => {
    const stamp = Date.now();
    setConversationItems((prev) => [
      ...prev,
      ...lines.map((line, i) => ({
        key: `${keyPrefix}_${stamp}_${i}`,
        type: "agent_message_content_line" as const,
        text: line,
        index: 0,
      })),
      { key: `${keyPrefix}_sep_${stamp}`, type: "separator" as const },
    ]);
  }, []);

  /**
   * Single entry point for every mode change (Shift+Tab, `/auto`, `/plan`).
   *
   * Deliberately writes nothing to the conversation: the status bar shows the
   * mode permanently, so a line per change would just be noise - and cycling
   * with Shift+Tab makes it easy to generate several in a row.
   */
  const applyChatMode = useCallback((next: ChatMode) => {
    if (chatModeRef.current === next) {
      return;
    }
    chatModeRef.current = next;
    setChatMode(next);
  }, []);

  const toggleAutoEdits = useCallback(() => {
    // `/auto` means "auto-accept on or off", so it toggles against normal
    // rather than stepping through the cycle - from plan mode it turns
    // auto-accept on, which is what asking for it implies.
    applyChatMode(chatModeRef.current === "auto" ? "normal" : "auto");
  }, [applyChatMode]);

  const togglePlanMode = useCallback(() => {
    applyChatMode(chatModeRef.current === "plan" ? "normal" : "plan");
  }, [applyChatMode]);

  const cycleChatMode = useCallback(() => {
    applyChatMode(nextChatMode(chatModeRef.current));
  }, [applyChatMode]);

  /**
   * Resolves a pending present_plan call with the user's decision.
   *
   * Declared here rather than beside requestDiffApproval because it needs
   * applyChatMode above - approval is what switches plan mode off.
   */
  const resolvePlanDecision = useCallback(
    async (decision: PlanDecision) => {
      if (!planApprovalResolver || pendingPlan === null) {
        return;
      }

      const approved = decision.kind === "approve";

      let savedPath: string | null = null;
      if (approved) {
        // Leaving plan mode is the *approval*, not the presenting: this is the
        // only place it happens, so the agent can't lift the restriction on
        // its own. Which mode it lands in is the user's choice: "implement now"
        // means auto-accept, since having just approved the whole plan they
        // don't want to confirm each edit within it; "wait" returns to normal,
        // where edits are confirmed one at a time.
        applyChatMode(decision.then === "auto" ? "auto" : "normal");
        savedPath = await saveApprovedPlan(currentConversationId, pendingPlan);
      }

      // Deliberately does NOT include the plan text - it's already permanent
      // on screen from the plan_proposed item requestPlanApproval pushed the
      // moment this plan was presented. Repeating it here in a second Static
      // item is what used to make it appear twice: pushed after the save so
      // it can name the file the plan landed in.
      setConversationItems((prev) => [
        ...prev,
        {
          key: `plan_decision_${Date.now()}`,
          type: "plan_decision" as const,
          filePath: savedPath,
          outcome:
            decision.kind === "approve"
              ? decision.then === "auto"
                ? "approved-auto"
                : "approved-wait"
              : "rejected",
          comment: decision.kind === "reject" ? decision.comment : undefined,
        },
      ]);

      planApprovalResolver(decision);
      setPendingPlan(null);
      setPlanApprovalResolver(null);
      setAwaitingPlanComment(false);
      setInlineSelector(null);
    },
    [planApprovalResolver, pendingPlan, applyChatMode, currentConversationId]
  );

  /**
   * Handles a choice from the plan approval prompt. "Reject with a comment"
   * doesn't resolve yet - it hands over to the normal input box to collect the
   * comment (see awaitingPlanComment), because a rejection reason is free text
   * and the selector has no room for it.
   */
  const handlePlanChoice = useCallback(
    (id: string) => {
      switch (id) {
        case "approve_auto":
          void resolvePlanDecision({ kind: "approve", then: "auto" });
          return;
        case "approve_wait":
          void resolvePlanDecision({ kind: "approve", then: "wait" });
          return;
        case "reject_comment":
          setInlineSelector(null);
          setAwaitingPlanComment(true);
          setUserInput("");
          setCursorPosition(0);
          return;
        default:
          void resolvePlanDecision({ kind: "reject" });
      }
    },
    [resolvePlanDecision]
  );

  const requestPlanApproval = useCallback(
    async (plan: string): Promise<PlanDecision> => {
      return new Promise<PlanDecision>((resolve) => {
        // Pushed as permanent scrollback immediately, before the ephemeral
        // selector even opens - see the plan_proposed item's comment in
        // Conversation.tsx for why the plan text must never again be shown
        // as ephemeral content (it's what caused the plan to render twice).
        setConversationItems((prev) => [
          ...prev,
          {
            key: `plan_proposed_${Date.now()}`,
            type: "plan_proposed" as const,
            planMarkdown: plan,
          },
        ]);

        setPendingPlan(plan);
        setPlanApprovalResolver(() => (decision: PlanDecision) => {
          resolve(decision);
        });

        setInlineSelector({
          mode: "plan",
          items: [
            {
              id: "approve_auto",
              label: "Approve and implement in auto mode",
            },
            {
              id: "approve_wait",
              label: "Approve and wait for further instructions",
            },
            { id: "reject_comment", label: "Reject with comment" },
            { id: "reject", label: "Reject" },
          ],
          query: "",
          selectedIndex: 0,
        });
      });
    },
    []
  );

  const stopLoop = useCallback(
    (reason: string) => {
      const current = loopRef.current;
      if (!current) {
        return false;
      }
      loopRef.current = null;
      setLoop(null);
      pushNoticeLines(
        [
          `↻ Loop stopped - ${reason}.`,
          `  Ran ${current.runs} of ${current.maxRuns}${
            current.skipped > 0
              ? `, skipped ${current.skipped} tick${
                  current.skipped === 1 ? "" : "s"
                } while the agent was busy`
              : ""
          }.`,
        ],
        "loop_stop"
      );
      return true;
    },
    [pushNoticeLines]
  );

  /**
   * Handles `/loop` in all its forms (see parseLoopCommand).
   *
   * A tick does not call handleSubmitQuestion directly - it appends to
   * `messageQueue`, and the existing drain effect sends it once the agent is
   * idle. That reuse is the whole reason this is small: "never overlap a
   * running turn" and "show what's pending" both already work for queued
   * messages, so a loop gets them for free.
   */
  const runLoopCommand = useCallback(
    (args: string) => {
      const parsed = parseLoopCommand(args);
      if (!parsed.ok) {
        pushNoticeLines([`↻ ${parsed.error}`], "loop_error");
        return;
      }

      const command = parsed.value;

      if (command.kind === "status") {
        const current = loopRef.current;
        pushNoticeLines(
          current
            ? [
                `↻ Looping ${describeLoop(current)}`,
                `  Prompt: ${current.prompt}`,
                "  /loop stop to cancel.",
              ]
            : [
                "↻ No loop running.",
                "  /loop <interval> <prompt> to start one, e.g. /loop 10m check CI and fix any failures",
                "  Add xN to cap the runs: /loop 10m x5 <prompt>",
              ],
          "loop_status"
        );
        return;
      }

      if (command.kind === "stop") {
        if (!stopLoop("cancelled")) {
          pushNoticeLines(["↻ No loop running."], "loop_status");
        }
        return;
      }

      if (loopRef.current) {
        pushNoticeLines(
          [
            "↻ A loop is already running - /loop stop it first.",
            `  Currently: ${describeLoop(loopRef.current)}`,
          ],
          "loop_error"
        );
        return;
      }

      const started: LoopState = {
        id: `loop_${Date.now()}`,
        intervalMs: command.intervalMs,
        prompt: command.prompt,
        runs: 0,
        maxRuns: command.maxRuns,
        skipped: 0,
      };
      loopRef.current = started;
      setLoop(started);

      pushNoticeLines(
        [
          `↻ Looping every ${formatInterval(command.intervalMs)}, up to ${
            command.maxRuns
          } runs.`,
          `  Prompt: ${command.prompt}`,
          "  Runs once now, then on the interval. Esc or /loop stop to cancel.",
        ],
        "loop_start"
      );
    },
    [pushNoticeLines, stopLoop]
  );

  /**
   * Toggles Claude Code mode: reads the memories and instruction files
   * Claude Code keeps for this directory (see utils/claudeMemory.ts) and
   * arranges for them to reach the agent once.
   *
   * The memories ride along with the *next* message the user sends rather
   * than being posted as a message of their own the moment the mode is
   * switched on. Both cost the same tokens, but a standalone priming
   * message spends a whole round trip on a context dump the agent can only
   * reply to with an acknowledgement - and burns credits doing it. Wrapping
   * the next real message is the same mechanism steering already uses
   * (buildSteerRedirectPrompt): what's sent to the agent is wrapped, what's
   * shown in the transcript is only ever what the user actually typed.
   */
  const toggleClaudeCodeMode = useCallback(() => {
    const enabling = !claudeCodeModeRef.current;

    if (!enabling) {
      setClaudeCodeMode(false);
      claudeCodeModeRef.current = false;
      claudeContextRef.current = null;
      pendingClaudePrimingRef.current = false;
      pushNoticeLines(
        [
          "◊ Claude Code mode off - memories already sent stay in this conversation's history.",
          "  Run /new for a conversation without them.",
        ],
        "ccmode_off"
      );
      return;
    }

    void (async () => {
      const context = await loadClaudeContext();
      const summary = summarizeContext(context);

      if (!hasAnyContext(context)) {
        // Nothing to send - leave the mode off rather than switching it on
        // and having it silently do nothing to every later message.
        pushNoticeLines(
          [
            "◊ Claude Code mode not enabled - no memories or instruction files found.",
            ...summary.map((line) => `  ${line}`),
          ],
          "ccmode_empty"
        );
        return;
      }

      claudeContextRef.current = context;
      pendingClaudePrimingRef.current = true;
      claudeCodeModeRef.current = true;
      setClaudeCodeMode(true);

      pushNoticeLines(
        [
          "◊ Claude Code mode on - the agent will be primed with:",
          ...summary.map((line) => `  · ${line}`),
          "  Sent once, with your next message. It is not shown in the transcript.",
        ],
        "ccmode_on"
      );
    })();
  }, [pushNoticeLines]);

  // Helper to create a conversation for file uploads if none exists
  // Only useful for uploading files to the first message
  const createConversationForFiles = useCallback(
    async (title: string) => {
      if (!selectedAgent || !me || meError || isMeLoading) {
        return null;
      }

      const dustClientRes = await getDustClient();
      if (dustClientRes.isErr()) {
        setError(dustClientRes.error.message);
        return null;
      }

      const dustClient = dustClientRes.value;
      if (!dustClient) {
        setError("Authentication required. Run `dustm login` first.");
        return null;
      }

      const convRes = await dustClient.createConversation({
        title,
        visibility: "unlisted",
        contentFragments: [],
        spaceId: resolvedSpaceId,
      });

      if (convRes.isErr()) {
        setError(`Failed to create conversation: ${convRes.error.message}`);
        return null;
      }

      setCurrentConversationId(convRes.value.conversation.sId);
      return convRes.value.conversation.sId;
    },
    [selectedAgent, me, meError, isMeLoading, resolvedSpaceId]
  );

  const handleFileSelected = useCallback(
    async (filePathOrPaths: string | string[]) => {
      // Normalize to array for unified handling
      const paths = Array.isArray(filePathOrPaths)
        ? filePathOrPaths
        : [filePathOrPaths];

      const fileInfos = [];
      for (const p of paths) {
        const fileInfoRes = await validateAndGetFileInfo(p);
        if (fileInfoRes.isErr()) {
          setError(`File error: ${normalizeError(fileInfoRes.error).message}`);
          return;
        }

        fileInfos.push(fileInfoRes.value);
      }

      let convId = currentConversationId;
      if (!convId) {
        convId = await createConversationForFiles(
          `File Upload: ${fileInfos.map((f) => f.name).join(", ")}`.slice(0, 50)
        );
        if (!convId) {
          // error already handled in createConversationForFiles
          return;
        }
      }

      setPendingFiles(fileInfos);
      setIsUploadingFiles(true);
    },
    [currentConversationId, createConversationForFiles]
  );

  const startNewConversation = useCallback(async () => {
    // Full wipe (screen + scrollback) - /new and /clear mean "give me a
    // genuine blank slate", so there shouldn't be anything left to scroll
    // back to.
    await clearTerminalAndScrollback();
    setConversationRenderKey((k) => k + 1);
    setCurrentConversationId(null);
    setConversationItems(
      selectedAgent
        ? [
            {
              key: "welcome_header",
              type: "welcome_header",
              agentName: selectedAgent.name,
              agentDescription: selectedAgent.description,
            },
          ]
        : []
    );
    setUploadedFiles([]);
    setPendingFiles([]);
    setContextUsage(null);

    // A new conversation has none of the old one's history, so the memories
    // the agent was primed with are gone with it - re-arm so the next
    // message primes the fresh conversation too. Uses the context already
    // read from disk, since /new shouldn't silently pick up memory edits
    // made since the mode was switched on (re-run /claude-code-mode for
    // that).
    if (claudeCodeModeRef.current && claudeContextRef.current) {
      pendingClaudePrimingRef.current = true;
    }

    // A loop is stopped rather than carried across: its prompt was written
    // for the conversation being discarded, and leaving it armed would have
    // it fire into the blank one without the user asking.
    stopLoop("/new started a fresh conversation");
  }, [selectedAgent, stopLoop]);

  const showHelp = useCallback(() => {
    const helpText =
      "Commands: /help /switch /new /clear /resume /attach /clear-files /auto /plan /loop /claude-code-mode /exit\n" +
      `Modes (Shift+Tab cycles, shown in the status bar): ${(
        ["normal", "auto", "plan"] as ChatMode[]
      )
        .map((m) => `${chatModeLabel(m)} = ${describeChatMode(m)}`)
        .join(" · ")}\n` +
      "Shortcuts: Enter=send · Ctrl+Enter/Shift+Enter=newline · Ctrl+W=delete word · Esc=clear/cancel · Ctrl+G=browser · @=mention a file";
    const lines = helpText.split("\n");
    setConversationItems((prev) => [
      ...prev,
      ...lines.map((line, i) => ({
        key: `help_line_${Date.now()}_${i}`,
        type: "agent_message_content_line" as const,
        text: line,
        index: 0,
      })),
      { key: `help_sep_${Date.now()}`, type: "separator" as const },
    ]);
  }, []);

  const handleConversationSelected = useCallback(
    async (convId: string) => {
      setConversationItems((prev) => [
        ...prev,
        {
          key: `loading_conv_${Date.now()}`,
          type: "agent_message_content_line" as const,
          text: "Loading conversation...",
          index: 0,
        },
      ]);

      const dustClientRes = await getDustClient();
      if (dustClientRes.isErr()) {
        setError(dustClientRes.error.message);
        return;
      }
      const dustClient = dustClientRes.value;
      if (!dustClient) {
        setError("Authentication required. Run `dustm login` first.");
        return;
      }

      const convRes = await dustClient.getConversation({
        conversationId: convId,
      });
      if (convRes.isErr()) {
        setError(`Failed to load conversation: ${convRes.error.message}`);
        return;
      }

      setCurrentConversationId(convId);
      const items = buildConversationItemsFromHistory(convRes.value, {
        name: selectedAgent?.name ?? "dust",
        description: selectedAgent?.description ?? "",
      });

      await clearTerminal();
      setConversationRenderKey((k) => k + 1);
      setConversationItems(items);
      void getContextUsage(convId).then(setContextUsageIfPresent);
      void getConsumedCredits().then(setConsumedCreditsIfPresent);
    },
    [selectedAgent, setContextUsageIfPresent, setConsumedCreditsIfPresent]
  );

  const resumeConversation = useCallback(async () => {
    setConversationItems((prev) => [
      ...prev,
      {
        key: `loading_resume_${Date.now()}`,
        type: "agent_message_content_line" as const,
        text: "Loading conversations...",
        index: 0,
      },
    ]);

    const dustClientRes = await getDustClient();
    if (dustClientRes.isErr()) {
      setError(dustClientRes.error.message);
      return;
    }
    const dustClient = dustClientRes.value;
    if (!dustClient) {
      setError("Authentication required. Run `dustm login` first.");
      return;
    }

    const convRes = await dustClient.getConversations();
    if (convRes.isErr()) {
      setError(`Failed to fetch conversations: ${convRes.error.message}`);
      return;
    }

    const conversations = convRes.value
      .filter((c) => c.visibility !== "deleted")
      .slice(0, 20);

    if (conversations.length === 0) {
      setConversationItems((prev) => [
        ...prev,
        {
          key: `resume_empty_${Date.now()}`,
          type: "agent_message_content_line" as const,
          text: "No recent conversations found.",
          index: 0,
        },
        { key: `resume_sep_${Date.now()}`, type: "separator" as const },
      ]);
      return;
    }

    const items: InlineSelectorItem[] = conversations.map((c) => ({
      id: c.sId,
      label: `${new Date(c.created).toLocaleDateString()} - ${c.title || "Untitled"}`,
    }));

    setUserInput("");
    setCursorPosition(0);
    setShowCommandSelector(false);
    setCommandQuery("");
    setSelectedCommandIndex(0);
    setCommandCursorPosition(0);

    setInlineSelector({
      mode: "conversation",
      items,
      query: "",
      selectedIndex: 0,
    });
  }, []);

  const commands = createCommands({
    triggerAgentSwitch,
    clearFiles,
    attachFile: showAttachDialog,
    toggleAutoEdits,
    startNewConversation,
    showHelp,
    resumeConversation,
    toggleClaudeCodeMode,
    runLoopCommand,
    togglePlanMode,
  });

  // Clear the terminal (screen + scrollback) once, when the interactive
  // chat first mounts - launching a chat session gets the same blank slate
  // /new and /clear give. Deliberately here rather than in index.tsx: this
  // component *is* the interactive chat, so one-shot commands (--version,
  // status, login, -m/--message, ...) don't get their output wiped, which
  // gating on argv in index.tsx would have to duplicate App.tsx's routing
  // to avoid. Runs after the first paint, so index.tsx's immediate
  // "Starting dustm..." feedback still shows during the (slow) module load
  // before this point.
  useEffect(() => {
    void (async () => {
      await clearTerminalAndScrollback();
      setConversationRenderKey((k) => k + 1);
    })();
  }, []);

  // Cache Edit tool when agent is selected, since approval is asked anyways
  // TODO: add check for the fact that we are using fs server when implemented
  useEffect(() => {
    const cacheEditTool = async () => {
      if (selectedAgent) {
        // Pre-cache the Edit tool to avoid approval prompts
        await toolsCache.setCachedApproval({
          mcpServerName: "fs-cli",
          toolName: "edit_file",
        });
      }
    };
    void cacheEditTool();
  }, [selectedAgent]);

  // Handle agent search when component mounts
  useEffect(() => {
    if (!agentSearch || !allAgents || allAgents.length === 0 || selectedAgent) {
      return;
    }

    // Search for agents matching the search string (case-insensitive)
    const searchLower = agentSearch.toLowerCase();
    const matchingAgents = allAgents.filter((agent) =>
      agent.name.toLowerCase().startsWith(searchLower)
    );

    if (matchingAgents.length === 0) {
      setError(`No agent found starting with "${agentSearch}"`);
      return;
    }

    // Select the first matching agent (same as SelectWithSearch behavior)
    const agentToSelect = matchingAgents[0];

    setSelectedAgent(agentToSelect);
    // Skip the generic welcome header when a specific conversation is about
    // to be resumed (--conversationId) - the resume effect below is about
    // to clear the terminal and replace conversationItems with the actual
    // history's own welcome header anyway. Painting this one first just
    // means two clear+remount cycles happen back to back instead of one,
    // which is what showed up as the status bar rendering twice (and with
    // the wrong colors on the first pass) right after a resume.
    if (!conversationId) {
      setConversationItems([
        {
          key: "welcome_header",
          type: "welcome_header",
          agentName: agentToSelect.name,
          agentDescription: agentToSelect.description,
        },
      ]);
    }
  }, [agentSearch, allAgents, selectedAgent, conversationId]);

  // Auto-select @dust agent when no agent/sId/search is specified
  useEffect(() => {
    if (selectedAgent || requestedAgentId || agentSearch) {
      return;
    }
    if (!allAgents || allAgents.length === 0) {
      return;
    }

    const dustAgent = allAgents.find((agent) => agent.sId === "dust");
    if (dustAgent) {
      setSelectedAgent(dustAgent);
      // See the matching comment in the agentSearch effect above: skip this
      // when a resume is about to replace it anyway.
      if (!conversationId) {
        setConversationItems([
          {
            key: "welcome_header",
            type: "welcome_header",
            agentName: dustAgent.name,
            agentDescription: dustAgent.description,
          },
        ]);
      }
    }
  }, [allAgents, selectedAgent, requestedAgentId, agentSearch, conversationId]);

  // Auto-initialize filesystem server when agent is selected.
  useEffect(() => {
    if (!selectedAgent || fileSystemInitialized) {
      return;
    }
    setFileSystemInitialized(true);

    void (async () => {
      const dustClientRes = await getDustClient();
      if (dustClientRes.isErr()) {
        setError(dustClientRes.error.message);
        return;
      }
      const dustClient = dustClientRes.value;
      if (!dustClient) {
        setError("Authentication required. Run `dustm login` first.");
        return;
      }

      const useFsServerRes = await useFileSystemServer(
        dustClient,
        (serverId) => {
          setFileSystemServerId(serverId);
        },
        requestDiffApproval,
        (attempt, maxAttempts, error) => {
          setRetryStatus(
            `[${attempt}/${maxAttempts}] Retrying file-system connection — ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        },
        requestPlanApproval
      );
      setRetryStatus(null);
      if (useFsServerRes.isErr()) {
        setError(useFsServerRes.error.message);
      }
    })();
  }, [
    selectedAgent,
    fileSystemInitialized,
    requestDiffApproval,
    requestPlanApproval,
  ]);

  // Load conversation history when resuming via --resume
  useEffect(() => {
    if (!conversationId || !selectedAgent || resumeLoadedRef.current) {
      return;
    }
    resumeLoadedRef.current = true;

    setConversationItems((prev) => [
      ...prev,
      {
        key: `loading_resume_init_${Date.now()}`,
        type: "agent_message_content_line" as const,
        text: "Loading conversation...",
        index: 0,
      },
    ]);

    void (async () => {
      const dustClientRes = await getDustClient();
      if (dustClientRes.isErr()) {
        setError(dustClientRes.error.message);
        return;
      }
      const dustClient = dustClientRes.value;
      if (!dustClient) {
        setError("Authentication required. Run `dustm login` first.");
        return;
      }

      const convRes = await dustClient.getConversation({
        conversationId,
      });
      if (convRes.isErr()) {
        setError(`Failed to load conversation: ${convRes.error.message}`);
        return;
      }

      const items = buildConversationItemsFromHistory(convRes.value, {
        name: selectedAgent.name,
        description: selectedAgent.description,
      });

      await clearTerminal();
      setConversationRenderKey((k) => k + 1);
      setConversationItems(items);
      void getContextUsage(conversationId).then(setContextUsageIfPresent);
      void getConsumedCredits().then(setConsumedCreditsIfPresent);
    })();
  }, [
    conversationId,
    selectedAgent,
    setContextUsageIfPresent,
    setConsumedCreditsIfPresent,
  ]);

  useEffect(() => {
    autoAcceptEditsRef.current = autoAcceptEdits;
  }, [autoAcceptEdits]);

  // Push the mode across into the module-level flag the MCP tools read (see
  // utils/planMode.ts). This effect is the single point where UI state becomes
  // tool behaviour, so the two can't disagree - including on the very first
  // render, which matters for `--plan`.
  useEffect(() => {
    chatModeRef.current = chatMode;
    setPlanMode(isPlanMode(chatMode));
  }, [chatMode]);

  useEffect(() => {
    claudeCodeModeRef.current = claudeCodeMode;
  }, [claudeCodeMode]);

  // A loop tick must not fire while its predecessor is still unsent or still
  // running, so it needs to know both. Mirrored into a ref because the tick
  // runs inside a setInterval closure.
  useEffect(() => {
    loopBusyRef.current =
      isProcessingQuestion || messageQueue.some((message) => message.loop);
  }, [isProcessingQuestion, messageQueue]);

  // The loop's timer. Keyed on the loop's id and interval only - not on the
  // whole object - so counting a run doesn't tear the interval down and
  // restart it, which would push every subsequent tick later.
  useEffect(() => {
    if (!loop) {
      return;
    }

    const tick = () => {
      const current = loopRef.current;
      if (!current) {
        return;
      }

      if (current.runs >= current.maxRuns) {
        stopLoop(`reached its ${current.maxRuns}-run limit`);
        return;
      }

      // Skip rather than stack. Queueing a tick that the agent has no chance
      // of reaching before the next one arrives is how an unattended loop
      // runs away with a credit balance.
      if (loopBusyRef.current) {
        const skipped = { ...current, skipped: current.skipped + 1 };
        loopRef.current = skipped;
        setLoop(skipped);
        showTransientHint(
          `↻ Loop tick skipped - agent still working (${skipped.skipped} so far).`
        );
        return;
      }

      const advanced = { ...current, runs: current.runs + 1 };
      loopRef.current = advanced;
      setLoop(advanced);
      setMessageQueue((prev) => [
        ...prev,
        {
          id: `loop_msg_${current.id}_${advanced.runs}`,
          text: current.prompt,
          files: [],
          steered: false,
          loop: true,
        },
      ]);
    };

    // Fire once straight away rather than making the user wait out a full
    // interval before anything happens - `/loop 1h <prompt>` should not sit
    // idle for an hour. Safe against re-running: this effect is keyed on the
    // loop's id, which doesn't change as runs are counted.
    tick();

    const intervalId = setInterval(tick, loop.intervalMs);

    // Cleanup matters here: without it, unmounting mid-loop (or re-arming)
    // would leave a timer running against a dead component.
    return () => clearInterval(intervalId);
  }, [loop?.id, loop?.intervalMs, stopLoop, showTransientHint]);

  // Note: intentionally does NOT gate on `!isProcessingQuestion` - while the
  // agent is still working, Enter queues the message instead of sending it
  // immediately (see the `key.return` handler below).
  const canSubmit =
    me && !meError && !isMeLoading && !inlineSelector && !!userInput.trim();

  const handleSubmitQuestion = useCallback(
    async (questionText: string, attachedFiles: UploadedFile[] = []) => {
      if (!selectedAgent || !me || meError || isMeLoading) {
        return;
      }

      // questionText is what was typed - it may still contain
      // "[Pasted N lines of text]" placeholders (kept compact while
      // composing so a huge paste doesn't flood the input box).
      // expandedQuestionText swaps those back in for good, and is what
      // gets shown in the transcript once sent - unlike the input box, the
      // permanent scrollback should show what was actually said, not a
      // placeholder that can never be expanded again after this point.
      let expandedQuestionText = questionText;
      for (const { placeholder, content } of pastedBlocksRef.current) {
        if (expandedQuestionText.includes(placeholder)) {
          expandedQuestionText = expandedQuestionText.replace(
            placeholder,
            content
          );
        }
      }
      pastedBlocksRef.current = [];

      // Only a genuinely new task (not a steer redirect) updates what
      // "the original task" means - a redirect keeps pointing back at
      // whatever it actually was, so a chain of interruptions doesn't lose
      // track of it in favor of the most recent interruption's text.
      if (!pendingSteerContextRef.current) {
        currentTurnPromptRef.current = expandedQuestionText;
      }

      // fullQuestionText starts the same, but may get further wrapped
      // (e.g. with steer redirect context) before being sent - that
      // wrapping is for the agent only, never shown in the transcript.
      let fullQuestionText = expandedQuestionText;
      if (pendingSteerContextRef.current) {
        const { partialContent } = pendingSteerContextRef.current;
        pendingSteerContextRef.current = null;
        fullQuestionText = buildSteerRedirectPrompt(
          currentTurnPromptRef.current,
          partialContent,
          fullQuestionText
        );
      }

      // Plan mode is stated on *every* message while it's on, not once: it can
      // be entered or left at any point (Shift+Tab works mid-turn), so each
      // turn has to carry the state that applies to it. Sits immediately above
      // the user's text - closest to the request it constrains - and below the
      // memory priming added next.
      if (isPlanMode(chatModeRef.current)) {
        fullQuestionText = `${planModePreamble()}\n\n${fullQuestionText}\n\n${planModeReminder()}`;
      }

      // Claude Code mode's one-time priming (see toggleClaudeCodeMode).
      // Applied after any steer wrapping so the memories sit above the whole
      // prompt. The latch is only cleared once the message has actually been
      // accepted by the API (further down, next to the transcript write) -
      // clearing it here would lose the memories for the rest of the
      // conversation on any of the failure paths in between, which abandon
      // the send entirely and leave the user to retype.
      const primingThisMessage =
        pendingClaudePrimingRef.current && claudeContextRef.current !== null;
      if (primingThisMessage && claudeContextRef.current) {
        fullQuestionText = `${buildPrimingBlock(
          claudeContextRef.current
        )}\n\n${fullQuestionText}`;
      }

      setConversationItems((prev) => {
        const lastUserMessage = getLastConversationItem<
          ConversationItem & { type: "user_message" }
        >(prev, "user_message");

        const newUserMessageIndex = lastUserMessage
          ? lastUserMessage.index + 1
          : 0;
        const newUserMessageKey = `user_message_${newUserMessageIndex}`;

        const lastAgentMessageHeader = getLastConversationItem<
          ConversationItem & { type: "agent_message_header" }
        >(prev, "agent_message_header");

        const newAgentMessageHeaderIndex = lastAgentMessageHeader
          ? lastAgentMessageHeader.index + 1
          : 0;
        const newAgentMessageHeaderKey = `agent_message_header_${newAgentMessageHeaderIndex}`;

        const newItems = [...prev];
        const itemsToAdd: ConversationItem[] = [
          {
            key: newUserMessageKey,
            type: "user_message",
            firstName: me.firstName ?? "You",
            content: expandedQuestionText,
            index: newUserMessageIndex,
          },
        ];

        // Add attachments if present
        if (attachedFiles.length > 0) {
          itemsToAdd.push({
            key: `user_message_attachments_${newUserMessageIndex}`,
            type: "user_message_attachments",
            attachments: attachedFiles,
            index: newUserMessageIndex,
          });
        }

        itemsToAdd.push({
          key: newAgentMessageHeaderKey,
          type: "agent_message_header",
          agentName: selectedAgent.name,
          index: newAgentMessageHeaderIndex,
        });

        return [...newItems, ...itemsToAdd];
      });

      setIsProcessingQuestion(true);
      setThinkingPreview("");
      setStreamingContentPreview([]);
      const controller = new AbortController();
      setAbortController(controller);
      agentMessageIdRef.current = null;
      toolCallInFlightRef.current = false;
      steerCancelPendingRef.current = false;

      const dustClientRes = await getDustClient();
      if (dustClientRes.isErr()) {
        setError(dustClientRes.error.message);
        return;
      }

      const dustClient = dustClientRes.value;
      if (!dustClient) {
        setError("Authentication required. Run `dustm login` first.");
        setIsProcessingQuestion(false);
        setConversationItems((prev) => prev.slice(0, -1));
        return;
      }

      let userMessageId: string;
      let conversation: CreateConversationResponseType["conversation"];

      // Hoisted out of the try block below so the crash-recovery path in
      // the catch block can also use it to render a recovered answer.
      //
      // Content is only ever committed to the permanent (Ink <Static>,
      // append-only) conversationItems list once, when the agent message
      // is complete — never incrementally while streaming. Static items
      // can't be edited after the fact, and markdown constructs like code
      // fences only render correctly once the full text is known, so
      // partial markdown is shown separately via the transient
      // streamingContentPreview state instead (see the interval below).
      //
      // Chain-of-thought is intentionally not included here either: it's
      // shown as a transient "Thinking…" status (see thinkingPreview
      // state) rather than being permanently written to scrollback,
      // matching how Claude Code/Cursor/Kimi Code hide raw reasoning by
      // default.
      const pushFinalContentToConversationItems = () => {
        const segments = renderMarkdownSegments(contentRef.current || " ");

        setConversationItems((prev) => {
          const lastAgentMessageHeader = getLastConversationItem<
            ConversationItem & { type: "agent_message_header" }
          >(prev, "agent_message_header");

          if (!lastAgentMessageHeader) {
            throw new Error("Unreachable: No agent message header found");
          }

          const agentMessageIndex = lastAgentMessageHeader.index;

          const contentItems: ConversationItem[] = segments.map(
            (segment, segmentIdx) =>
              segment.type === "code"
                ? {
                    key: `agent_message_code_${agentMessageIndex}_${segmentIdx}`,
                    type: "agent_message_code_block",
                    text: segment.content,
                    index: agentMessageIndex,
                  }
                : {
                    key: `agent_message_text_${agentMessageIndex}_${segmentIdx}`,
                    type: "agent_message_text_segment",
                    text: segment.content,
                    index: agentMessageIndex,
                  }
          );

          return [
            ...prev,
            ...contentItems,
            {
              key: `end_of_agent_message_separator_${agentMessageIndex}`,
              type: "separator",
            },
          ];
        });
      };

      // Live, transient preview of the current chain-of-thought (last
      // non-empty line, truncated), shown only in the "Thinking…" status
      // line — never written into permanent scrollback.
      const updateThinkingPreview = () => {
        const lines = chainOfThoughtRef.current
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        const lastLine = lines[lines.length - 1] ?? "";
        setThinkingPreview(
          lastLine.length > 100 ? `${lastLine.slice(0, 100)}...` : lastLine
        );
      };

      // Before surfacing a fatal error from the stream below, check whether
      // the agent's answer actually completed successfully server-side
      // despite the client-side failure (e.g. the known @dust-tt/client SSE
      // "done"-sentinel bug that exhausts its reconnect budget even though
      // the answer already landed). Returns the recovered text, or null if
      // recovery wasn't possible/didn't find a completed answer.
      const tryRecoverAgentAnswer = async (): Promise<string | null> => {
        if (!conversation) {
          return null;
        }
        const recoveryRes = await dustClient.getConversation({
          conversationId: conversation.sId,
        });
        if (recoveryRes.isErr()) {
          return null;
        }
        let lastAgentMessageContent: string | null = null;
        for (const group of recoveryRes.value.content) {
          for (const msg of group) {
            if (msg.type === "agent_message" && msg.content) {
              lastAgentMessageContent = msg.content;
            }
          }
        }
        return lastAgentMessageContent;
      };

      // Wrapped in a closure (rather than read inline in the catch block)
      // so TypeScript's definite-assignment analysis doesn't treat this as
      // a use of `conversation` before it's assigned.
      const getConversationIdSuffix = (): string => {
        if (!conversation) {
          return "";
        }
        const agentFlag = selectedAgent
          ? ` --agent "${selectedAgent.name}"`
          : "";
        return `\n\nTo resume this conversation, run:\ndustm${agentFlag} --resume ${conversation.sId}`;
      };

      // Same closure-scoping reason as above.
      const appendRecoveredAgentTranscriptEntry = (text: string): void => {
        if (conversation) {
          void appendTranscriptEntry(conversation.sId, {
            role: "agent",
            text,
          });
        }
      };

      // Same closure-scoping reason as above.
      const refreshUsageStats = (): void => {
        if (conversation) {
          void getContextUsage(conversation.sId).then(setContextUsageIfPresent);
          void getConsumedCredits().then(setConsumedCreditsIfPresent);
        }
      };

      try {
        let createdContentFragments = [];
        // If there are files to attach, create content fragments for each
        if (attachedFiles.length > 0 && currentConversationId) {
          for (const file of attachedFiles) {
            const fragmentRes = await dustClient.postContentFragment({
              conversationId: currentConversationId,
              contentFragment: {
                title: file.fileName,
                fileId: file.fileId,
              },
            });
            if (fragmentRes.isErr()) {
              setError(
                `Failed to create content fragment: ${fragmentRes.error.message}`
              );
              setIsProcessingQuestion(false);
              return;
            }
            createdContentFragments.push({
              type: "file_attachment",
              fileId: file.fileId,
              title: file.fileName,
            });
          }
        }

        if (!currentConversationId) {
          // For new conversation, pass contentFragments (from uploaded files)
          const contentFragments = attachedFiles.map((file) => ({
            type: "file_attachment" as const,
            fileId: file.fileId,
            title: file.fileName,
          }));

          const convRes = await dustClient.createConversation({
            // Titled from what the user actually typed, not from
            // fullQuestionText - that may carry a wrapper the user never
            // wrote (Claude Code mode's priming block, which lands on the
            // first message of a conversation and would otherwise become
            // its title).
            title: `CLI Question: ${expandedQuestionText.substring(0, 30)}${
              expandedQuestionText.length > 30 ? "..." : ""
            }`,
            visibility: "unlisted",
            message: {
              content: fullQuestionText,
              mentions: [{ configurationId: selectedAgent.sId }],
              context: {
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                username: me.username,
                fullName: me.fullName,
                email: me.email,
                origin: "cli",
                clientSideMCPServerIds: fileSystemServerId
                  ? [fileSystemServerId]
                  : null,
              },
            },
            contentFragments,
            spaceId: resolvedSpaceId,
          });

          if (convRes.isErr()) {
            throw new Error(
              `Failed to create conversation: ${convRes.error.message}`
            );
          }

          conversation = convRes.value.conversation;
          setCurrentConversationId(conversation.sId);

          if (!convRes.value.message) {
            throw new Error("No message created");
          }
          userMessageId = convRes.value.message.sId;
        } else {
          const workspaceId = await AuthService.getSelectedWorkspaceId();
          if (!workspaceId) {
            throw new Error("No workspace selected");
          }

          const messageRes = await dustClient.postUserMessage({
            conversationId: currentConversationId,
            message: {
              content: fullQuestionText,
              mentions: [{ configurationId: selectedAgent.sId }],
              context: {
                clientSideMCPServerIds: fileSystemServerId
                  ? [fileSystemServerId]
                  : null,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                username: me.username,
                fullName: me.fullName,
                email: me.email,
                origin: "cli",
              },
            },
          });

          if (messageRes.isErr()) {
            throw new Error(
              `Error creating message: ${messageRes.error.message}`
            );
          }

          userMessageId = messageRes.value.sId;

          // Get the conversation for streaming
          const convRes = await dustClient.getConversation({
            conversationId: currentConversationId,
          });
          if (convRes.isErr()) {
            throw new Error(
              `Error retrieving conversation: ${convRes.error.message}`
            );
          }
          conversation = convRes.value;
        }

        // For cancelCurrentGeneration - see its definition for why this
        // needs to be a real cancelMessageGeneration call, not just a
        // client-side abort.
        activeDustClientRef.current = dustClient;
        activeConversationIdRef.current = conversation.sId;

        // The message carrying the priming block is on the server now, so
        // the latch can be dropped - anything from here on (a failed answer
        // stream, a cancel) leaves it in the conversation's history, and
        // re-priming a later message would only duplicate it.
        if (primingThisMessage) {
          pendingClaudePrimingRef.current = false;
        }

        // Crash-safety net: record the user's side of the exchange before
        // waiting on the agent's (potentially long-running, potentially
        // failing) stream below.
        void appendTranscriptEntry(conversation.sId, {
          role: "user",
          text: fullQuestionText,
          messageId: userMessageId,
        });

        // Stream the agent's response. Retried on transient failure since
        // this only subscribes to an existing message's answer - unlike
        // createConversation/postUserMessage above, it has no duplicate-
        // side-effect risk on retry.
        const streamRes = await retryResult(
          () =>
            dustClient.streamAgentAnswerEvents({
              conversation: conversation,
              userMessageId: userMessageId,
              signal: controller.signal, // Add the abort signal
            }),
          5,
          500,
          (attempt, maxAttempts, error) => {
            setRetryStatus(
              `[${attempt}/${maxAttempts}] Retrying answer stream — ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        );
        setRetryStatus(null);

        if (streamRes.isErr()) {
          throw new Error(
            `Failed to stream agent answer: ${streamRes.error.message}`
          );
        }

        let usageRefreshTickCount = 0;
        updateIntervalRef.current = setInterval(() => {
          updateThinkingPreview();
          setStreamingContentPreview(
            renderMarkdownSegments(
              truncateForStreamingPreview(contentRef.current)
            )
          );
          // A long stretch of plain-text generation (no tool calls to
          // trigger the refresh above) would otherwise leave the status
          // bar's numbers frozen for the whole turn - piggyback on this
          // existing 1s tick, but only act on every 20th one so a long
          // task still feels "live" without hammering the endpoint every
          // second.
          usageRefreshTickCount++;
          if (usageRefreshTickCount % 20 === 0) {
            refreshUsageStats();
          }
        }, 1000);

        for await (const event of streamRes.value.eventStream) {
          if (
            !agentMessageIdRef.current &&
            "messageId" in event &&
            event.messageId
          ) {
            agentMessageIdRef.current = event.messageId;
          }

          if (event.type === "generation_tokens") {
            if (event.classification === "tokens") {
              contentRef.current += event.text;
            } else if (event.classification === "chain_of_thought") {
              chainOfThoughtRef.current += event.text;
            }
          } else if (event.type === "agent_error") {
            throw new Error(`Agent error: ${event.error.message}`);
          } else if (event.type === "user_message_error") {
            throw new Error(`User message error: ${event.error.message}`);
          } else if (event.type === "agent_generation_cancelled") {
            // Handle generation cancellation
            if (updateIntervalRef.current) {
              clearInterval(updateIntervalRef.current);
            }
            setActionStatus(null);
            setError(null);
            chainOfThoughtRef.current = "";
            setThinkingPreview("");
            setStreamingContentPreview([]);
            // A steer sets pendingSteerContextRef just before cancelling
            // (and it isn't consumed until the redirect message is
            // actually submitted, which happens after this turn ends), so
            // it's a reliable "this cancel was a steer, not a plain
            // Esc/Ctrl+C" signal here.
            const cancelWasSteer = pendingSteerContextRef.current !== null;
            // Keep whatever had been written before the cut-off; the
            // marker below covers the "nothing was written yet" case
            // instead of standing in as fake message content.
            if (contentRef.current.trim()) {
              pushFinalContentToConversationItems();
            }
            appendCancellationMarker(cancelWasSteer);
            contentRef.current = "";
            break;
          } else if (event.type === "agent_message_success") {
            if (updateIntervalRef.current) {
              clearInterval(updateIntervalRef.current);
            }
            setActionStatus(null);
            setError(null);
            setStreamingContentPreview([]);
            pushFinalContentToConversationItems();
            void getContextUsage(conversation.sId).then(
              setContextUsageIfPresent
            );
            void getConsumedCredits().then(setConsumedCreditsIfPresent);
            void appendTranscriptEntry(conversation.sId, {
              role: "agent",
              text: contentRef.current,
              messageId: event.message.sId,
            });
            chainOfThoughtRef.current = "";
            setThinkingPreview("");
            contentRef.current = "";
            break;
          } else if (event.type === "tool_params") {
            setActionStatus(
              event.action.displayLabels?.running ?? "Running a tool"
            );
            toolCallInFlightRef.current = true;
          } else if (event.type === "agent_action_success") {
            setActionStatus(null);
            toolCallInFlightRef.current = false;

            // Each completed tool call is a natural checkpoint where usage
            // actually changed - refresh here rather than waiting for the
            // whole turn to end, so a long multi-tool-call task shows its
            // context/credit numbers moving instead of sitting frozen
            // until it's all done.
            refreshUsageStats();

            // A steer requested while this tool call was running was held
            // rather than interrupting it mid-flight - fire it now that
            // the call has safely completed (its result survives the
            // cancellation about to happen; only the text below would be
            // lost, which is why it's captured here to re-supply).
            flushPendingSteer();
          } else if (event.type === "tool_approve_execution") {
            const approved = await handleApprovalRequest(event);
            await dustClient.validateAction({
              conversationId: event.conversationId,
              messageId: event.messageId,
              actionId: event.actionId,
              approved: approved ? "approved" : "rejected",
            });
          }
        }
      } catch (error) {
        if (controller.signal.aborted) {
          setAbortController(null);
          setActionStatus(null);
          if (updateIntervalRef.current) {
            clearInterval(updateIntervalRef.current);
          }

          appendCancellationMarker(pendingSteerContextRef.current !== null);

          chainOfThoughtRef.current = "";
          setThinkingPreview("");
          setStreamingContentPreview([]);
          contentRef.current = "";

          setIsProcessingQuestion(false);

          return;
        }

        const recoveredText = await tryRecoverAgentAnswer();
        if (recoveredText) {
          if (updateIntervalRef.current) {
            clearInterval(updateIntervalRef.current);
          }
          setActionStatus(null);
          setError(null);
          chainOfThoughtRef.current = "";
          setThinkingPreview("");
          setStreamingContentPreview([]);
          contentRef.current = recoveredText;
          pushFinalContentToConversationItems();
          refreshUsageStats();
          appendRecoveredAgentTranscriptEntry(recoveredText);
          contentRef.current = "";
          setIsProcessingQuestion(false);
          setAbortController(null);
          return;
        }

        setError(
          `Error: ${normalizeError(error).message}${getConversationIdSuffix()}`
        );
      } finally {
        setIsProcessingQuestion(false);
        setAbortController(null);
        setRetryStatus(null);
      }
    },
    [
      selectedAgent,
      currentConversationId,
      me,
      meError,
      isMeLoading,
      uploadedFiles,
      fileSystemServerId,
      resolvedSpaceId,
      flushPendingSteer,
    ]
  );

  // Auto-send the next queued message once the current turn has finished -
  // whether it completed normally, was cancelled via Esc/Ctrl+C, or was
  // interrupted by a genuine Ctrl+S steer (see cancelCurrentGeneration).
  useEffect(() => {
    if (isProcessingQuestion || messageQueue.length === 0) {
      return;
    }
    if (!selectedAgent || !me || meError || isMeLoading) {
      return;
    }
    const [next, ...rest] = messageQueue;
    setMessageQueue(rest);
    void handleSubmitQuestion(next.text, next.files);
  }, [
    isProcessingQuestion,
    messageQueue,
    selectedAgent,
    me,
    meError,
    isMeLoading,
    handleSubmitQuestion,
  ]);

  // Pulls the most recently queued message back into the input for editing
  // or cancellation (Esc now clears the draft without aborting - see the
  // `key.escape` handler below), mirroring Claude Code. Bound to both
  // Backspace-on-empty-input and Up-arrow-on-empty-input.
  const recallLastQueuedMessage = useCallback(() => {
    setMessageQueue((prev) => {
      if (prev.length === 0) {
        return prev;
      }
      const last = prev[prev.length - 1];
      setUserInput(last.text);
      setCursorPosition(last.text.length);
      setUploadedFiles(last.files);
      return prev.slice(0, -1);
    });
  }, []);

  // Handle file upload completion
  const handleFileUploadComplete = useCallback(
    (files: UploadedFile[]) => {
      setUploadedFiles(files);
      setIsUploadingFiles(false);
      setPendingFiles([]);

      // If there's a message waiting to be sent with these files, send it
      // now - or queue it if the agent is still working a prior turn.
      if (userInput.trim()) {
        if (isProcessingQuestion) {
          setMessageQueue((prev) => [
            ...prev,
            {
              id: `queued_${Date.now()}_${prev.length}`,
              text: userInput,
              files,
              steered: false,
            },
          ]);
        } else {
          void handleSubmitQuestion(userInput, files);
        }
        setUserInput("");
        setCursorPosition(0);
        setHistoryIndex(null);
      }
    },
    [userInput, isProcessingQuestion, handleSubmitQuestion]
  );

  // Handle file upload error
  const handleFileUploadError = useCallback((error: string) => {
    setError(error);
    setIsUploadingFiles(false);
    setPendingFiles([]);
  }, []);

  // Ink's `useInput` normalizes both the physical Backspace key (raw DEL
  // byte, 0x7F) and the physical Delete key (CSI `\x1b[3~`) to the same
  // `key.delete` flag - there's no way to tell them apart from the `key`
  // object alone. Tap Ink's own raw input feed (the same EventEmitter
  // `useInput` is built on) to capture the raw sequence ourselves; since
  // EventEmitter listeners fire in registration order and this effect is
  // declared - and therefore registered - before the `useInput` call below,
  // this ref is always up to date by the time that handler runs.
  const lastRawWasForwardDeleteRef = useRef(false);
  // Home/End go further than that: Ink's parser recognizes them (see
  // ink/build/parse-keypress.js) but the `key` object it hands to
  // `useInput` has no `.home`/`.end` field at all, so both arrive as
  // `input === ""` with every flag false - a complete no-op as far as this
  // app could tell, which is why End didn't appear to do anything. Same
  // workaround as above: read the raw sequence directly and match it
  // against every variant these keys are known to send.
  const lastRawSequenceRef = useRef("");
  const { internal_eventEmitter } = useStdin();
  useEffect(() => {
    if (!internal_eventEmitter) {
      return;
    }
    const handleRawInput = (chunk: Buffer | string) => {
      const raw = chunk.toString();
      lastRawSequenceRef.current = raw;
      lastRawWasForwardDeleteRef.current = raw === "\x1b[3~";
    };
    internal_eventEmitter.on("input", handleRawInput);
    return () => {
      internal_eventEmitter.removeListener("input", handleRawInput);
    };
  }, [internal_eventEmitter]);

  // Handle keyboard events.
  useInput((input, key) => {
    // Ctrl+C: cancel an in-flight generation immediately (mirrors ESC), but
    // never exit the whole session on a single accidental press while idle
    // — require a second press within 2s, with a visible hint in between.
    // (Ink's default exitOnCtrlC is disabled in index.tsx for this reason.)
    if (key.ctrl && input === "c") {
      // Same reasoning as Esc: stop the loop too, or the interrupt looks
      // like it didn't take when the next tick arrives.
      stopLoop("Ctrl+C");
      if (isProcessingQuestion && abortController) {
        setIsCancelling(true);
        void cancelCurrentGeneration();
        return;
      }
      const now = Date.now();
      if (now - lastCtrlCTimeRef.current < 2000) {
        // A double Ctrl+C is easy to hit by mistake (e.g. reflexively
        // interrupting a runaway turn), and unlike /exit it gives no
        // chance to note the conversation/agent down first - print the
        // exact command to pick it back up, right under the status bar
        // that's about to disappear with the rest of the screen.
        if (currentConversationId && selectedAgent) {
          process.stdout.write(
            `\nTo continue this conversation, run 'dustm --agent ${selectedAgent.name} --conversationId ${currentConversationId}'.\n\n`
          );
        }
        exit();
        return;
      }
      lastCtrlCTimeRef.current = now;
      if (exitHintTimeoutRef.current) {
        clearTimeout(exitHintTimeoutRef.current);
      }
      setShowExitHint(true);
      exitHintTimeoutRef.current = setTimeout(() => {
        setShowExitHint(false);
      }, 2000);
      return;
    }

    // Shift+Tab cycles the permission mode (normal -> auto-accept -> plan),
    // matching Claude Code. Handled here, ahead of every other key, so it
    // works while the agent is mid-turn - switching to plan mode because you
    // saw it about to do something you don't want is exactly when you need it.
    //
    // Ink reports the backtab sequence (CSI Z) as tab+shift, which is why the
    // command selector's own Tab handler checks `!key.shift`. Skipped while an
    // inline selector is open: those have their own Tab/Enter semantics, and
    // changing the mode underneath a pending approval prompt would be
    // ambiguous.
    if (key.tab && key.shift && !inlineSelector) {
      cycleChatMode();
      return;
    }

    // Ctrl+S: steer - genuinely interrupts the current turn server-side
    // (via cancelCurrentGeneration/cancelMessageGeneration, confirmed by
    // direct testing to actually stop the agent, unlike a bare abort) and
    // sends this message as a redirect. If a tool call is currently
    // running, the interrupt is held until it finishes rather than firing
    // mid-flight (untested/assumed risky) - see cancelCurrentGeneration and
    // the agent_action_success handler above for where that's applied.
    if (key.ctrl && input === "s") {
      const keyLabel = "Ctrl+S";
      if (!isProcessingQuestion) {
        showTransientHint(`${keyLabel} only steers while the agent is working.`);
      } else if (!userInput.trim() && messageQueue.length === 0) {
        showTransientHint(
          `${keyLabel}: type a message, or queue one, then press ${keyLabel} to steer it.`
        );
      } else {
        // Prefer what's currently typed; if the input is empty, steer the
        // most recently queued message instead of requiring it to be
        // retyped.
        const sourcedFromQueue = !userInput.trim();
        const steerMessage = sourcedFromQueue
          ? messageQueue[messageQueue.length - 1].text
          : userInput;
        const steerFiles = sourcedFromQueue
          ? messageQueue[messageQueue.length - 1].files
          : uploadedFiles;

        if (sourcedFromQueue) {
          setMessageQueue((prev) => prev.slice(0, -1));
        } else {
          setUserInput("");
          setCursorPosition(0);
          setUploadedFiles([]);
        }

        // Queue it immediately either way, so the "Steered" block appears
        // the moment the key is pressed rather than only once the next
        // stream event arrives - the queue's auto-send effect won't fire
        // while the turn is still in flight, so this is safe even when the
        // cancellation below is deferred. (It also can't be tracked in a
        // ref for this: refs don't re-render.)
        setMessageQueue((prev) => [
          {
            id: `steer_${Date.now()}`,
            text: steerMessage,
            files: steerFiles,
            steered: true,
          },
          ...prev,
        ]);

        if (toolCallInFlightRef.current) {
          // Hold the actual interrupt until the running tool call finishes
          // - see the agent_action_success handler.
          steerCancelPendingRef.current = true;
          showTransientHint(
            `${keyLabel}: steering as soon as the current tool call finishes...`
          );
        } else {
          pendingSteerContextRef.current = { partialContent: contentRef.current };
          void cancelCurrentGeneration();
        }
      }
      return;
    }

    if (!selectedAgent) {
      return;
    }

    // Track how long it's been since the previous keystroke event. Pasted
    // multi-line text on terminals without bracketed-paste support (e.g.
    // this box's legacy Windows console) arrives as a rapid sequence of
    // individual keystroke events rather than one batched input, so a
    // human-speed gap is used below to tell a real Enter press apart from
    // an embedded newline in a paste.
    const now = Date.now();
    const isRapidSuccession = now - lastKeystrokeTimeRef.current < 15;
    lastKeystrokeTimeRef.current = now;

    // Handle inline selector keyboard (agent switch, file browser, approval).
    if (inlineSelector) {
      if (key.escape) {
        if (inlineSelector.mode === "approval") {
          void handleApproval(false);
        } else if (inlineSelector.mode === "diff") {
          void handleDiffApproval(false);
        } else if (inlineSelector.mode === "plan") {
          // Esc on a plan means "not this one" - a plain rejection, which keeps
          // plan mode on. It must not simply dismiss the prompt: the
          // present_plan tool call is still awaiting an answer, and
          // abandoning it would hang the turn.
          void resolvePlanDecision({ kind: "reject" });
        } else {
          setInlineSelector(null);
        }
        return;
      }

      const isFixedMode =
        inlineSelector.mode === "approval" ||
        inlineSelector.mode === "diff" ||
        inlineSelector.mode === "plan";
      const filtered = isFixedMode
        ? inlineSelector.items
        : inlineSelector.items.filter((item) =>
            item.label
              .toLowerCase()
              .includes(inlineSelector.query.toLowerCase())
          );
      const maxVisible = 10;
      const visibleCount = Math.min(filtered.length, maxVisible);

      if (key.upArrow) {
        setInlineSelector((prev) =>
          prev
            ? { ...prev, selectedIndex: Math.max(0, prev.selectedIndex - 1) }
            : prev
        );
        return;
      }

      if (key.downArrow) {
        setInlineSelector((prev) =>
          prev
            ? {
                ...prev,
                selectedIndex: Math.min(
                  visibleCount - 1,
                  prev.selectedIndex + 1
                ),
              }
            : prev
        );
        return;
      }

      if (key.return) {
        if (
          filtered.length > 0 &&
          inlineSelector.selectedIndex < filtered.length
        ) {
          const selected = filtered[inlineSelector.selectedIndex];

          if (inlineSelector.mode === "approval") {
            const approved =
              selected.id === "approve" || selected.id === "approve_and_cache";
            const cacheApproval = selected.id === "approve_and_cache";
            void handleApproval(approved, cacheApproval);
            return;
          }

          if (inlineSelector.mode === "diff") {
            void handleDiffApproval(selected.id === "accept");
            return;
          }

          if (inlineSelector.mode === "plan") {
            handlePlanChoice(selected.id);
            return;
          }

          if (inlineSelector.mode === "agent") {
            const agent = (allAgents || []).find((a) => a.sId === selected.id);
            if (agent) {
              setSelectedAgent(agent);
              setConversationItems((prev) => [
                ...prev,
                {
                  key: `switch_${Date.now()}`,
                  type: "agent_message_content_line",
                  text: `Switched to @${agent.name}`,
                  index: 0,
                },
                { key: `switch_sep_${Date.now()}`, type: "separator" },
              ]);
            }
            setInlineSelector(null);
          } else if (inlineSelector.mode === "file") {
            if (selected.id === "__more__") {
              return;
            }
            if (selected.id === "__clipboard__") {
              setInlineSelector(null);
              void (async () => {
                const clipRes = await getClipboardImagePath();
                if (clipRes.isErr()) {
                  pushNotice(
                    `Failed to read clipboard image: ${clipRes.error.message}`
                  );
                  return;
                }
                if (clipRes.value === null) {
                  pushNotice("No image found on the clipboard.");
                  return;
                }
                await handleFileSelected(clipRes.value);
              })();
              return;
            }
            void (async () => {
              try {
                const targetStat = await stat(selected.id);
                if (targetStat.isDirectory()) {
                  const items = await loadDirectoryItems(selected.id);
                  setInlineSelector({
                    mode: "file",
                    items,
                    query: "",
                    selectedIndex: 0,
                    currentPath: selected.id,
                  });
                } else {
                  const ext = getFileExtension(selected.id);
                  if (isSupportedFileType(ext)) {
                    setInlineSelector(null);
                    await handleFileSelected(selected.id);
                  }
                }
              } catch {
                setInlineSelector(null);
              }
            })();
          } else if (inlineSelector.mode === "mention") {
            // userInput/cursorPosition were never touched while this
            // selector was open (typing went into `query` instead, same as
            // every other filterable mode) - so they're still exactly what
            // they were when "@" was pressed, and mentionAnchor is where it
            // sits. Splice the chosen path in there, in place of the "@".
            const anchor = inlineSelector.mentionAnchor ?? cursorPosition;
            const insertion = `@${selected.id} `;
            const newInput =
              userInput.slice(0, anchor) + insertion + userInput.slice(anchor);
            setUserInput(newInput);
            setCursorPosition(anchor + insertion.length);
            setInlineSelector(null);
          } else if (inlineSelector.mode === "conversation") {
            void handleConversationSelected(selected.id);
            setInlineSelector(null);
          }
        }
        return;
      }

      // Suppress typing/backspace in fixed-option modes (no filtering needed)
      if (isFixedMode) {
        return;
      }

      if (key.backspace || key.delete) {
        setInlineSelector((prev) =>
          prev
            ? {
                ...prev,
                query: prev.query.slice(0, -1),
                selectedIndex: 0,
              }
            : prev
        );
        return;
      }

      if (!key.ctrl && !key.meta && input && input.length === 1) {
        setInlineSelector((prev) =>
          prev
            ? {
                ...prev,
                query: prev.query + input,
                selectedIndex: 0,
              }
            : prev
        );
      }
      return;
    }

    const isInCommandMode = showCommandSelector;
    const currentInput = isInCommandMode ? commandQuery : userInput;
    const currentCursorPos = isInCommandMode
      ? commandCursorPosition
      : cursorPosition;
    const setCurrentInput = isInCommandMode ? setCommandQuery : setUserInput;
    const setCurrentCursorPos = isInCommandMode
      ? setCommandCursorPosition
      : setCursorPosition;

    // Handle command selector specific navigation.
    if (showCommandSelector) {
      if (key.escape) {
        setShowCommandSelector(false);
        setCommandQuery("");
        setSelectedCommandIndex(0);
        setCommandCursorPosition(0);
        return;
      }

      if (key.upArrow) {
        setSelectedCommandIndex((prev) => Math.max(0, prev - 1));
        return;
      }

      // Only the first token names the command; the rest are its arguments
      // (see splitCommandQuery). Matching must ignore them, or a command
      // stops being findable the moment its arguments are typed.
      const [commandName, commandArgs] = splitCommandQuery(commandQuery);
      const filteredCommands = commands.filter((cmd) =>
        cmd.name.toLowerCase().startsWith(commandName.toLowerCase())
      );

      if (key.downArrow) {
        setSelectedCommandIndex((prev) =>
          Math.min(filteredCommands.length - 1, prev + 1)
        );
        return;
      }

      if (key.return) {
        if (
          filteredCommands.length > 0 &&
          selectedCommandIndex < filteredCommands.length
        ) {
          const selectedCommand = filteredCommands[selectedCommandIndex];
          void selectedCommand.execute(commandArgs);
          setShowCommandSelector(false);
          setCommandQuery("");
          setSelectedCommandIndex(0);
          setCommandCursorPosition(0);
          setUserInput("");
          setCursorPosition(0);
        }
        return;
      }

      // Tab completes the currently-highlighted command's name into the
      // input (shell-style), without running it - Enter still does that.
      // A command that takes arguments gets a trailing space, so typing can
      // continue straight into them.
      if (key.tab && !key.shift) {
        if (
          filteredCommands.length > 0 &&
          selectedCommandIndex < filteredCommands.length
        ) {
          const selectedCommand = filteredCommands[selectedCommandIndex];
          const completed = selectedCommand.usage
            ? `${selectedCommand.name} `
            : selectedCommand.name;
          setCommandQuery(completed);
          setCommandCursorPosition(completed.length);
        }
        return;
      }
    }

    if (key.ctrl && input === "g") {
      if (currentConversationId) {
        void (async () => {
          const workspaceId = await AuthService.getSelectedWorkspaceId();
          if (workspaceId) {
            const url = `https://dust.tt/w/${workspaceId}/agent/${currentConversationId}`;
            await open(url);
          } else {
            console.error("\nCould not determine workspace ID");
          }
        })();
      }
      return;
    }

    // (Shift+Tab was handled at the top of this handler - it used to toggle
    // auto-accept as a binary here, and now cycles all three permission modes
    // instead. Moved up so it also works mid-turn, which is when switching to
    // plan mode is most useful.)

    // Ctrl+V for an image: when the clipboard holds only an image (no
    // text), most terminals - including Windows Terminal - have nothing to
    // paste as text, so they pass the raw Ctrl+V keystroke through instead
    // of intercepting it. That's what this relies on. When the clipboard
    // *does* have text, the terminal consumes Ctrl+V for the normal text
    // paste instead and this branch never fires - no conflict either way.
    if (
      key.ctrl &&
      input === "v" &&
      !isInCommandMode &&
      SUPPORTS_CLIPBOARD_IMAGE
    ) {
      void (async () => {
        const clipRes = await getClipboardImagePath();
        if (clipRes.isErr()) {
          pushNotice(
            `Failed to read clipboard image: ${clipRes.error.message}`
          );
          return;
        }
        if (clipRes.value === null) {
          return;
        }
        await handleFileSelected(clipRes.value);
      })();
      return;
    }

    if (key.escape) {
      // While collecting a rejection comment, Esc means "reject, never mind the
      // comment" rather than clearing the draft: the present_plan call is still
      // waiting, so it has to be answered one way or another.
      if (awaitingPlanComment) {
        void resolvePlanDecision({ kind: "reject" });
        setUserInput("");
        setCursorPosition(0);
        return;
      }

      // Clearing a draft (including one just recalled from the queue via
      // Up-arrow, below) takes priority over interrupting generation - so
      // Esc can discard a queued/in-progress message without also
      // cancelling the agent's current turn. Press Esc again with an empty
      // input to interrupt.
      if (userInput) {
        setUserInput("");
        setCursorPosition(0);
        pastedBlocksRef.current = [];
        setHistoryIndex(null);
        return;
      }

      // With nothing typed, Esc on a running loop stops the loop as well as
      // interrupting the current turn. Cancelling only the turn would leave
      // the loop to re-send moments later, which reads as Esc not working.
      const stoppedLoop = stopLoop("Esc");
      if (isProcessingQuestion && abortController) {
        setIsCancelling(true);
        void cancelCurrentGeneration();
      } else if (!stoppedLoop) {
        // Nothing to clear, stop or cancel - leave the existing no-op
        // behaviour rather than inventing feedback for an idle Esc.
      }
      return;
    }

    // Check for Ctrl+Enter or Shift+Enter to add a new line, or regular
    // Enter to submit
    if (key.return && !isInCommandMode) {
      // Ctrl+Enter / Shift+Enter: insert a literal newline directly.
      // Whether the terminal actually reports Enter with a modifier held
      // (rather than being indistinguishable from plain Enter) is
      // terminal-dependent — if neither is detected here, that's the
      // terminal not reporting it, not a bug in this check.
      if (key.ctrl || key.shift) {
        const newInput =
          userInput.slice(0, cursorPosition) +
          "\n" +
          userInput.slice(cursorPosition);
        setUserInput(newInput);
        setCursorPosition(cursorPosition + 1);
        return;
      }

      // Enter while collecting a rejection comment submits the comment to the
      // waiting present_plan call, not a message to the agent. Checked before
      // the paste heuristics below because a multi-line rejection comment is
      // fine but a *sent message* here would leave the plan unanswered.
      if (awaitingPlanComment) {
        void resolvePlanDecision({
          kind: "reject",
          // Empty is allowed and means the same as a plain rejection - having
          // opened the comment box and thought better of it shouldn't trap the
          // user with nothing but Esc.
          comment: userInput.trim() || undefined,
        });
        setUserInput("");
        setCursorPosition(0);
        return;
      }

      // A `return` arriving faster than a human can physically press Enter
      // after other input is almost certainly an embedded newline from a
      // pasted multi-line block delivered keystroke-by-keystroke, not a
      // deliberate Enter press — insert it as a literal newline instead of
      // submitting prematurely.
      if (isRapidSuccession) {
        const newInput =
          userInput.slice(0, cursorPosition) +
          "\n" +
          userInput.slice(cursorPosition);
        setUserInput(newInput);
        setCursorPosition(cursorPosition + 1);
        return;
      }

      // Only allow submission/queueing if "me" is loaded and user input is not empty
      if (!canSubmit) {
        return;
      }

      if (isProcessingQuestion) {
        // The agent is still working the current turn - queue this message
        // instead of sending it now. It's sent automatically once the
        // in-flight turn ends.
        setMessageQueue((prev) => [
          ...prev,
          {
            id: `queued_${Date.now()}_${prev.length}`,
            text: userInput,
            files: uploadedFiles,
            steered: false,
          },
        ]);
        setUserInput("");
        setCursorPosition(0);
        setUploadedFiles([]);
        setHistoryIndex(null);
        return;
      }

      // No files, send message immediately
      void handleSubmitQuestion(userInput, uploadedFiles);
      setUserInput("");
      setCursorPosition(0);
      setUploadedFiles([]); // Clear uploaded files after sending
      setHistoryIndex(null);

      return;
    }

    // Ctrl+Backspace / Ctrl+W: delete the previous word (mirrors readline's
    // unix-word-rubout binding). Ctrl+Backspace's exact reported key shape
    // varies by terminal, so both are supported; Ctrl+W is the reliable,
    // terminal-agnostic fallback. Ctrl+Delete is handled separately below -
    // Delete removes the *next* word, not the previous one.
    if (
      currentCursorPos > 0 &&
      key.ctrl &&
      (key.backspace || input === "w")
    ) {
      let newPosition = currentCursorPos - 1;
      while (newPosition > 0 && /\s/.test(currentInput[newPosition])) {
        newPosition--;
      }
      while (newPosition > 0 && !/\s/.test(currentInput[newPosition - 1])) {
        newPosition--;
      }
      setCurrentInput(
        currentInput.slice(0, newPosition) +
          currentInput.slice(currentCursorPos)
      );
      setCurrentCursorPos(newPosition);
      if (isInCommandMode) {
        setSelectedCommandIndex(0);
      }
      return;
    }

    // Ctrl+Delete: delete the next word (mirrors readline's kill-word
    // binding), i.e. the forward counterpart of Ctrl+Backspace above.
    if (currentCursorPos < currentInput.length && key.ctrl && key.delete) {
      let newPosition = currentCursorPos;
      if (/\s/.test(currentInput[newPosition])) {
        while (
          newPosition < currentInput.length &&
          /\s/.test(currentInput[newPosition])
        ) {
          newPosition++;
        }
      } else {
        while (
          newPosition < currentInput.length &&
          !/\s/.test(currentInput[newPosition])
        ) {
          newPosition++;
        }
      }
      setCurrentInput(
        currentInput.slice(0, currentCursorPos) +
          currentInput.slice(newPosition)
      );
      if (isInCommandMode) {
        setSelectedCommandIndex(0);
      }
      return;
    }

    if (key.backspace || key.delete) {
      // Forward delete (removes the character at/after the cursor, cursor
      // stays put) - only when the raw sequence confirms this was the
      // physical Delete key, not Backspace (see lastRawWasForwardDeleteRef
      // above for why `key.delete` alone can't tell them apart).
      if (key.delete && lastRawWasForwardDeleteRef.current) {
        if (currentCursorPos < currentInput.length) {
          setCurrentInput(
            currentInput.slice(0, currentCursorPos) +
              currentInput.slice(currentCursorPos + 1)
          );
          if (isInCommandMode) {
            setSelectedCommandIndex(0);
          }
        }
        return;
      }

      if (currentCursorPos > 0) {
        setCurrentInput(
          currentInput.slice(0, currentCursorPos - 1) +
            currentInput.slice(currentCursorPos)
        );
        setCurrentCursorPos(Math.max(0, currentCursorPos - 1));
        if (isInCommandMode) {
          setSelectedCommandIndex(0);
        }
      } else if (isInCommandMode && commandQuery.length === 0) {
        // If query is empty and backspace is pressed, close command selector.
        setShowCommandSelector(false);
        setCommandQuery("");
        setSelectedCommandIndex(0);
        setCommandCursorPosition(0);
      } else if (
        !isInCommandMode &&
        userInput === "" &&
        messageQueue.length > 0
      ) {
        recallLastQueuedMessage();
      }
      return;
    }

    // Handle option+left (meta+b, Mac convention) or Ctrl+Left (Windows/
    // Linux convention) to move to the previous word
    if (
      ((key.meta && input === "b") || (key.ctrl && key.leftArrow)) &&
      currentCursorPos > 0
    ) {
      let newPosition = currentCursorPos - 1;

      while (newPosition > 0 && /\s/.test(currentInput[newPosition])) {
        newPosition--;
      }

      while (newPosition > 0 && !/\s/.test(currentInput[newPosition - 1])) {
        newPosition--;
      }

      setCurrentCursorPos(newPosition);
      return;
    }

    // Handle option+right (meta+f, Mac convention) or Ctrl+Right (Windows/
    // Linux convention) to move to the next word
    if (
      ((key.meta && input === "f") || (key.ctrl && key.rightArrow)) &&
      currentCursorPos < currentInput.length
    ) {
      let newPosition = currentCursorPos;

      // If we're on whitespace, skip to next non-whitespace.
      if (/\s/.test(currentInput[newPosition])) {
        while (
          newPosition < currentInput.length &&
          /\s/.test(currentInput[newPosition]) &&
          currentInput[newPosition] !== "\n"
        ) {
          newPosition++;
        }

        // If we hit a newline, stop there.
        if (currentInput[newPosition] === "\n") {
          setCurrentCursorPos(newPosition);
          return;
        }
      } else {
        // Skip the current word.
        while (
          newPosition < currentInput.length &&
          !/\s/.test(currentInput[newPosition])
        ) {
          newPosition++;
        }

        // Skip spaces after the word, but stop at newline.
        while (
          newPosition < currentInput.length &&
          /\s/.test(currentInput[newPosition]) &&
          currentInput[newPosition] !== "\n"
        ) {
          newPosition++;
        }
      }

      setCurrentCursorPos(newPosition);
      return;
    }

    // Handle cmd+left (ctrl+a) to go to beginning of line
    if (key.ctrl && input === "a") {
      if (isInCommandMode) {
        setCurrentCursorPos(0);
      } else {
        let newPosition = currentCursorPos;
        while (newPosition > 0 && currentInput[newPosition - 1] !== "\n") {
          newPosition--;
        }
        setCurrentCursorPos(newPosition);
      }
      return;
    }

    // Handle cmd+right (ctrl+e) to go to end of line
    if (key.ctrl && input === "e") {
      if (isInCommandMode) {
        setCurrentCursorPos(currentInput.length);
      } else {
        let newPosition = currentCursorPos;
        while (
          newPosition < currentInput.length &&
          currentInput[newPosition] !== "\n"
        ) {
          newPosition++;
        }
        setCurrentCursorPos(newPosition);
      }
      return;
    }

    // Home/End: move to the beginning/end of the current line (same target
    // as Ctrl+A/Ctrl+E above) - see lastRawSequenceRef for why these can't
    // be detected via `key` directly.
    if (
      input === "" &&
      !key.ctrl &&
      !key.shift &&
      !key.meta &&
      HOME_KEY_SEQUENCES.has(lastRawSequenceRef.current)
    ) {
      let newPosition = currentCursorPos;
      while (newPosition > 0 && currentInput[newPosition - 1] !== "\n") {
        newPosition--;
      }
      setCurrentCursorPos(newPosition);
      return;
    }

    if (
      input === "" &&
      !key.ctrl &&
      !key.shift &&
      !key.meta &&
      END_KEY_SEQUENCES.has(lastRawSequenceRef.current)
    ) {
      let newPosition = currentCursorPos;
      while (
        newPosition < currentInput.length &&
        currentInput[newPosition] !== "\n"
      ) {
        newPosition++;
      }
      setCurrentCursorPos(newPosition);
      return;
    }

    // Regular arrow key handling (left/right for character movement)
    if (key.leftArrow && currentCursorPos > 0) {
      setCurrentCursorPos(currentCursorPos - 1);
      return;
    }

    if (key.rightArrow && currentCursorPos < currentInput.length) {
      setCurrentCursorPos(currentCursorPos + 1);
      return;
    }

    // Up-arrow on an empty input recalls the most recently queued message
    // for editing or cancellation (clear it with Esc, or just send it as-is)
    // - the same recall Backspace already does, surfaced on a more
    // discoverable key. Only fires when the input is empty, so it never
    // fights with the line-navigation Up-arrow handles below.
    if (
      key.upArrow &&
      !isInCommandMode &&
      userInput === "" &&
      messageQueue.length > 0
    ) {
      recallLastQueuedMessage();
      return;
    }

    // Shell-history-style recall: when there's nothing queued to pull from
    // instead, Up-arrow steps backward through this conversation's own
    // previously sent messages (most recent first), Down-arrow steps back
    // forward. Gated to single-line input (no embedded "\n") past the
    // first press so it never fights with the line-navigation Up/Down
    // handles below for a genuinely multi-line draft/recalled message.
    if (
      key.upArrow &&
      !isInCommandMode &&
      messageQueue.length === 0 &&
      (userInput === "" ||
        (historyIndex !== null && !userInput.includes("\n")))
    ) {
      const userMessageHistory = conversationItems
        .filter(
          (item): item is ConversationItem & { type: "user_message" } =>
            item.type === "user_message"
        )
        .map((item) => item.content)
        .filter((content) => !PASTE_PLACEHOLDER_RE.test(content));
      if (userMessageHistory.length > 0) {
        const nextIndex =
          historyIndex === null
            ? userMessageHistory.length - 1
            : Math.max(0, historyIndex - 1);
        setHistoryIndex(nextIndex);
        const text = userMessageHistory[nextIndex];
        setUserInput(text);
        setCursorPosition(text.length);
      }
      return;
    }

    if (
      key.downArrow &&
      !isInCommandMode &&
      historyIndex !== null &&
      !userInput.includes("\n")
    ) {
      const userMessageHistory = conversationItems
        .filter(
          (item): item is ConversationItem & { type: "user_message" } =>
            item.type === "user_message"
        )
        .map((item) => item.content)
        .filter((content) => !PASTE_PLACEHOLDER_RE.test(content));
      if (historyIndex >= userMessageHistory.length - 1) {
        setHistoryIndex(null);
        setUserInput("");
        setCursorPosition(0);
      } else {
        const nextIndex = historyIndex + 1;
        setHistoryIndex(nextIndex);
        const text = userMessageHistory[nextIndex];
        setUserInput(text);
        setCursorPosition(text.length);
      }
      return;
    }

    if (key.upArrow && !isInCommandMode) {
      const lines = currentInput.split("\n");
      let currentPos = 0;
      let lineIndex = 0;
      let posInLine = 0;

      // Find current line and position within that line.
      for (let i = 0; i < lines.length; i++) {
        if (
          currentCursorPos >= currentPos &&
          currentCursorPos <= currentPos + lines[i].length
        ) {
          lineIndex = i;
          posInLine = currentCursorPos - currentPos;
          break;
        }
        currentPos += lines[i].length + 1; // +1 for newline
      }

      // Move to previous line.
      if (lineIndex > 0) {
        const prevLineLength = lines[lineIndex - 1].length;
        const newPosInLine = Math.min(posInLine, prevLineLength);

        // Calculate new cursor position.
        let newCursorPos = 0;
        for (let i = 0; i < lineIndex - 1; i++) {
          newCursorPos += lines[i].length + 1;
        }
        newCursorPos += newPosInLine;

        setCurrentCursorPos(newCursorPos);
      } else {
        // Already on first line, go to beginning.
        setCurrentCursorPos(0);
      }
      return;
    }

    if (key.downArrow && !isInCommandMode) {
      const lines = currentInput.split("\n");
      let currentPos = 0;
      let lineIndex = 0;
      let posInLine = 0;

      // Find current line and position within that line.
      for (let i = 0; i < lines.length; i++) {
        if (
          currentCursorPos >= currentPos &&
          currentCursorPos <= currentPos + lines[i].length
        ) {
          lineIndex = i;
          posInLine = currentCursorPos - currentPos;
          break;
        }
        currentPos += lines[i].length + 1; // +1 for newline
      }

      // Move to next line.
      if (lineIndex < lines.length - 1) {
        const nextLineLength = lines[lineIndex + 1].length;
        const newPosInLine = Math.min(posInLine, nextLineLength);

        // Calculate new cursor position.
        let newCursorPos = 0;
        for (let i = 0; i <= lineIndex; i++) {
          newCursorPos += lines[i].length + 1;
        }
        newCursorPos += newPosInLine;

        setCurrentCursorPos(newCursorPos);
      } else {
        // Already on last line, go to end.
        setCurrentCursorPos(currentInput.length);
      }
      return;
    }

    // Handle regular character input
    if (!key.ctrl && !key.meta && input && input.length === 1) {
      // Check if typing "/" at the beginning of an empty input
      if (
        input === "/" &&
        userInput === "" &&
        cursorPosition === 0 &&
        !isInCommandMode
      ) {
        setShowCommandSelector(true);
        setCommandQuery("");
        setSelectedCommandIndex(0);
        setCommandCursorPosition(0);
        return;
      }

      // "@" opens a file-mention popup, same trigger convention as most
      // chat tools: only when it starts a fresh token (start of input, or
      // right after whitespace), so an email address or the like typed
      // mid-word doesn't hijack the keyboard. Falls through to a plain "@"
      // character otherwise.
      if (
        input === "@" &&
        !isInCommandMode &&
        (cursorPosition === 0 ||
          /\s/.test(userInput.charAt(cursorPosition - 1)))
      ) {
        const anchor = cursorPosition;
        setInlineSelector({
          mode: "mention",
          items: [],
          query: "",
          selectedIndex: 0,
          mentionAnchor: anchor,
        });
        void loadMentionFiles().then((items) => {
          setInlineSelector((prev) =>
            prev && prev.mode === "mention" && prev.mentionAnchor === anchor
              ? { ...prev, items }
              : prev
          );
        });
        return;
      }

      const newInput =
        currentInput.slice(0, currentCursorPos) +
        input +
        currentInput.slice(currentCursorPos);
      setCurrentInput(newInput);
      setCurrentCursorPos(currentCursorPos + 1);
      if (isInCommandMode) {
        setSelectedCommandIndex(0);
      }
    } else if (input.length > 1) {
      // This is a special case that can happen with some terminals when pasting
      // without explicit keyboard shortcuts - they send the entire pasted content
      // as a single input event

      // Some terminals translate newlines to \r, so we normalize that to \n
      const normalizedInput = input.replace(/\r/g, "\n");

      // Large pastes get collapsed to a placeholder rather than dumping
      // hundreds of lines into the input box - the real content is kept in
      // pastedBlocksRef and swapped back in at submit time.
      const lineCount = normalizedInput.split("\n").length;
      let textToInsert = normalizedInput;
      if (lineCount > PASTE_COMPACT_LINE_THRESHOLD) {
        const placeholder = `[Pasted ${lineCount} lines of text]`;
        pastedBlocksRef.current.push({
          placeholder,
          content: normalizedInput,
        });
        textToInsert = placeholder;
      }

      const newInput =
        currentInput.slice(0, currentCursorPos) +
        textToInsert +
        currentInput.slice(currentCursorPos);
      setCurrentInput(newInput);
      setCurrentCursorPos(currentCursorPos + textToInsert.length);
      if (isInCommandMode) {
        setSelectedCommandIndex(0);
      }
    }
  });

  // Show loading state while searching for agent
  if (agentSearch && agentsIsLoading) {
    return (
      <Box flexDirection="column">
        <Text color="green">
          Searching for agent matching "{agentSearch}"...
        </Text>
      </Box>
    );
  }

  // Show loading state while resolving project/space
  if (isResolvingSpace) {
    return (
      <Box flexDirection="column">
        <Text color="green">
          Resolving project "{projectName || projectId}"...
        </Text>
      </Box>
    );
  }

  // Render error state
  if (error || agentsError) {
    return (
      <Box flexDirection="column" height="100%">
        <Box flexDirection="column" flexGrow={1}>
          <Box marginY={1}>
            <Box borderStyle="classic" borderColor="red" padding={1}>
              <Text>{error || agentsError}</Text>
            </Box>
          </Box>
        </Box>

        <Box flexDirection="column" marginTop={0} paddingTop={0}>
          <Box marginTop={0}>
            <Text color="gray">Press Ctrl+C to exit</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (!selectedAgent && !agentSearch) {
    // If no --sId flag and no agent search, wait for auto-select to kick in
    if (!requestedAgentId) {
      return (
        <Box flexDirection="column">
          <Text color={MANTU_THINKING_PINK}>
            <ThinkingIcon /> Loading dustm
            <Spinner type="simpleDots" />
          </Text>
        </Box>
      );
    }

    return (
      <AgentSelector
        selectMultiple={false}
        requestedAgentIds={requestedAgentId ? [requestedAgentId] : []}
        onError={setError}
        onConfirm={async (agents) => {
          setSelectedAgent(agents[0]);
          // See the matching comment on the agentSearch effect above: skip
          // this when a resume (--conversationId) is about to replace it.
          if (!conversationId) {
            setConversationItems([
              {
                key: "welcome_header",
                type: "welcome_header",
                agentName: agents[0].name,
                agentDescription: agents[0].description,
              },
            ]);
          }
        }}
      />
    );
  }

  const mentionPrefix = selectedAgent ? `@${selectedAgent.name} ` : "";

  // Main chat UI
  return (
    <Box flexDirection="column">
      {/* File upload component */}
      {pendingFiles.length > 0 && currentConversationId && (
        <FileUpload
          files={pendingFiles}
          onUploadComplete={handleFileUploadComplete}
          onUploadError={handleFileUploadError}
          conversationId={currentConversationId}
        />
      )}

      {/* Display uploaded files ready to be sent */}
      {uploadedFiles.length > 0 && !isUploadingFiles && (
        <Box flexDirection="column" marginY={1}>
          <Box borderStyle="classic" borderColor="green" padding={1}>
            <Box flexDirection="column">
              <Text color="green" bold>
                📁 {uploadedFiles.length} file
                {uploadedFiles.length > 1 ? "s" : ""}
              </Text>

              {uploadedFiles.map((file) => {
                const isImage = isImageFile(file.contentType);

                return (
                  <Box key={file.path} flexDirection="column" marginTop={1}>
                    <Box>
                      <Text color={isImage ? "yellow" : "cyan"}>
                        {isImage ? "🖼️  " : "📄 "} {file.fileName}
                      </Text>
                      <Text color="gray">
                        {" "}
                        ({formatFileSize(file.fileSize)})
                      </Text>
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </Box>
        </Box>
      )}

      <Conversation
        key={conversationRenderKey}
        conversationItems={conversationItems}
        isProcessingQuestion={isProcessingQuestion}
        isCancelling={isCancelling}
        actionStatus={actionStatus}
        queuedMessages={messageQueue}
        thinkingPreview={thinkingPreview}
        streamingContentPreview={streamingContentPreview}
        showExitHint={showExitHint}
        retryStatus={retryStatus}
        transientHint={transientHint}
        workspaceName={workspaceName}
        consumedCredits={consumedCredits}
        contextUsage={contextUsage}
        userInput={inlineSelector ? inlineSelector.query : userInput}
        cursorPosition={
          inlineSelector ? inlineSelector.query.length : cursorPosition
        }
        mentionPrefix={
          awaitingPlanComment
            ? "Why reject it? (Enter to send, Esc to reject without a reason) "
            : inlineSelector
            ? inlineSelector.mode === "agent"
              ? "Switch agent: "
              : inlineSelector.mode === "file"
                ? `📁 ${inlineSelector.currentPath ?? ""} `
                : inlineSelector.mode === "mention"
                  ? "📎 Mention a file: "
                  : inlineSelector.mode === "conversation"
                  ? "Resume conversation: "
                  : inlineSelector.mode === "approval" &&
                      pendingApproval &&
                      pendingApproval.type === "tool_approve_execution"
                    ? `Tool Approval Required: the agent wants to use ${pendingApproval.metadata.toolName}, what do you want to do? `
                    : inlineSelector.mode === "diff" && pendingDiffApproval
                      ? `Changes Preview: ${pendingDiffApproval.filePath} `
                      : inlineSelector.mode === "plan"
                        ? "Plan ready for review — approve to start implementing "
                        : mentionPrefix
            : mentionPrefix
        }
        conversationId={currentConversationId}
        stdout={stdout}
        showCommandSelector={showCommandSelector}
        commandQuery={commandQuery}
        selectedCommandIndex={selectedCommandIndex}
        commandCursorPosition={commandCursorPosition}
        commands={commands}
        chatMode={chatMode}
        claudeCodeMode={claudeCodeMode}
        loop={loop}
        inlineSelector={
          inlineSelector
            ? {
                items: inlineSelector.items,
                query: inlineSelector.query,
                selectedIndex: inlineSelector.selectedIndex,
                prompt:
                  inlineSelector.mode === "agent"
                    ? "Select an agent:"
                    : inlineSelector.mode === "file"
                      ? "Select a file:"
                      : inlineSelector.mode === "mention"
                        ? "Select a file to mention:"
                        : inlineSelector.mode === "conversation"
                        ? "Select a conversation:"
                        : inlineSelector.mode === "approval" ||
                            inlineSelector.mode === "diff" ||
                            inlineSelector.mode === "plan"
                          ? "Use Up/Down to navigate, Enter to confirm, Esc to reject:"
                          : undefined,
                header:
                  inlineSelector.mode === "approval" &&
                  pendingApproval &&
                  pendingApproval.type === "tool_approve_execution" &&
                  pendingApproval.inputs ? (
                    <Box flexDirection="column" marginBottom={1}>
                      <Text dimColor>Inputs:</Text>
                      <Text>{formatInputs(pendingApproval.inputs)}</Text>
                    </Box>
                  ) : inlineSelector.mode === "diff" && pendingDiffApproval ? (
                    <Box flexDirection="column" marginBottom={1}>
                      {/*
                        Capped: this preview is ephemeral non-static output,
                        and letting it exceed the terminal height makes Ink
                        clear-and-reprint everything each render (flicker).
                        The permanent copy pushed to the transcript after
                        approval renders the diff in full.
                      */}
                      <DiffView {...pendingDiffApproval} maxLines={14} />
                    </Box>
                  ) : inlineSelector.mode === "plan" ? (
                    // The plan itself is NOT repeated here - it was already
                    // pushed as permanent, Static scrollback the moment
                    // requestPlanApproval was called (see plan_proposed in
                    // Conversation.tsx), immediately above this prompt. This
                    // header used to re-render the full plan text as
                    // ephemeral content on every keystroke here, which is
                    // what caused it to appear twice: Ink erases and redraws
                    // its ephemeral region by moving the cursor up a fixed
                    // number of lines, and that count desyncs once the region
                    // is taller than the terminal - a real plan easily is.
                    // The leftover, never-fully-erased ephemeral copy is
                    // exactly what showed up sitting above the new permanent
                    // one. Keeping this header to one line, always, is what
                    // keeps that arithmetic safe.
                    <Box marginBottom={1}>
                      <Text dimColor>↑ Reviewing the plan proposed above.</Text>
                    </Box>
                  ) : undefined,
              }
            : null
        }
      />
    </Box>
  );
};

export default CliChat;
