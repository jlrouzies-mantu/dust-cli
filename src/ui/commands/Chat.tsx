import type {
  AgentActionSpecificEvent,
  ConversationPublicType,
  CreateConversationResponseType,
  GetAgentConfigurationsResponseType,
} from "@dust-tt/client";
import chalk from "chalk";
import { structuredPatch } from "diff";
import { readdir, stat } from "fs/promises";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import open from "open";
import path from "path";
import type { FC } from "react";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { useFileSystemServer } from "../../mcp/servers/fsServer.js";
import type { TodoItem } from "../../mcp/tools/todoWrite.js";
import { todoListEmitter } from "../../mcp/tools/todoWrite.js";
import AuthService from "../../utils/authService.js";
import { getClipboardImagePath } from "../../utils/clipboardImage.js";
import type { ContextUsage } from "../../utils/contextUsage.js";
import { getContextUsage } from "../../utils/contextUsage.js";
import type { CreditsUsage } from "../../utils/creditsInfo.js";
import { getConsumedCredits } from "../../utils/creditsInfo.js";
import { getDustClient } from "../../utils/dustClient.js";
import { normalizeError } from "../../utils/errors.js";
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
import { clearTerminal } from "../../utils/terminal.js";
import { toolsCache } from "../../utils/toolsCache.js";
import { appendTranscriptEntry } from "../../utils/transcriptStore.js";
import AgentSelector from "../components/AgentSelector.js";
import type { ConversationItem } from "../components/Conversation.js";
import Conversation from "../components/Conversation.js";
import type { UploadedFile } from "../components/FileUpload.js";
import { FileUpload } from "../components/FileUpload.js";
import type { InlineSelectorItem } from "../components/InlineSelector.js";
import { resolveSpaceId, validateProjectFlags } from "./chat/nonInteractive.js";
import { createCommands } from "./types.js";

type AgentConfiguration =
  GetAgentConfigurationsResponseType["agentConfigurations"][number];

interface CliChatProps {
  sId?: string;
  agentSearch?: string;
  conversationId?: string;
  autoAcceptEditsFlag?: boolean;
  projectName?: string;
  projectId?: string;
}

// Pastes with more lines than this get collapsed to a placeholder in the
// input box instead of dumping the raw text inline.
const PASTE_COMPACT_LINE_THRESHOLD = 4;

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
  projectName,
  projectId,
}) => {
  const [autoAcceptEdits, setAutoAcceptEdits] = useState(!!autoAcceptEditsFlag);
  const autoAcceptEditsRef = useRef(autoAcceptEdits);

  const [error, setError] = useState<string | null>(null);

  const [selectedAgent, setSelectedAgent] = useState<AgentConfiguration | null>(
    null
  );
  const [isProcessingQuestion, setIsProcessingQuestion] = useState(false);
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
  const [showCommandSelector, setShowCommandSelector] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [commandCursorPosition, setCommandCursorPosition] = useState(0);
  const [inlineSelector, setInlineSelector] = useState<{
    mode: "agent" | "file" | "conversation" | "approval" | "diff";
    items: InlineSelectorItem[];
    query: string;
    selectedIndex: number;
    currentPath?: string;
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
  const [pendingFiles, setPendingFiles] = useState<FileInfo[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
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
        setError("Authentication required. Run `dust login` first.");
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
      // offered here as a selectable entry instead. Windows-only for now,
      // see clipboardImage.ts.
      if (process.platform === "win32") {
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

  const formatInputs = (inputs: unknown): string => {
    if (!inputs) {
      return "";
    }
    if (typeof inputs === "string") {
      return inputs;
    }
    if (typeof inputs === "object" && !Array.isArray(inputs)) {
      return Object.entries(inputs as Record<string, unknown>)
        .map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
        .join("\n");
    }
    return JSON.stringify(inputs, null, 2);
  };

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

  const renderDiffLines = (diff: {
    originalContent: string;
    updatedContent: string;
    filePath: string;
  }) => {
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

    return lines.map((line, index) => {
      const { color, symbol } = DIFF_TYPE_MAP[line.type];
      return (
        <Text key={index}>
          {chalk.hex(color)(`${symbol}${line.lineNumber}: ${line.content}`)}
        </Text>
      );
    });
  };

  const handleApprovalRequest = useCallback(
    async (event: AgentActionSpecificEvent): Promise<boolean> => {
      if (event.type !== "tool_approve_execution") {
        return false;
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
        diffApprovalResolver(approved);
        setPendingDiffApproval(null);
        setDiffApprovalResolver(null);
        setInlineSelector(null);
      }
    },
    [diffApprovalResolver, pendingDiffApproval]
  );

  const requestDiffApproval = useCallback(
    async (
      originalContent: string,
      updatedContent: string,
      filePath: string
    ): Promise<boolean> => {
      // If always accept flag is set, immediately return true
      if (autoAcceptEditsRef.current) {
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
    []
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

  const toggleAutoEdits = useCallback(() => {
    setAutoAcceptEdits((prev) => !prev);
  }, [setAutoAcceptEdits]);

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
        setError("Authentication required. Run `dust login` first.");
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
    await clearTerminal();
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
  }, [selectedAgent]);

  const showHelp = useCallback(() => {
    const helpText =
      "Commands: /help /switch /new /resume /attach /clear-files /auto /exit\n" +
      "Shortcuts: Enter=send · Ctrl+Enter/Shift+Enter=newline · Ctrl+W=delete word · Esc=clear/cancel · Ctrl+G=browser";
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
        setError("Authentication required. Run `dust login` first.");
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
      setError("Authentication required. Run `dust login` first.");
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
  });

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

    // Set the selected agent and initial conversation items
    setSelectedAgent(agentToSelect);
    setConversationItems([
      {
        key: "welcome_header",
        type: "welcome_header",
        agentName: agentToSelect.name,
        agentDescription: agentToSelect.description,
      },
    ]);
  }, [agentSearch, allAgents, selectedAgent]);

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
      setConversationItems([
        {
          key: "welcome_header",
          type: "welcome_header",
          agentName: dustAgent.name,
          agentDescription: dustAgent.description,
        },
      ]);
    }
  }, [allAgents, selectedAgent, requestedAgentId, agentSearch]);

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
        setError("Authentication required. Run `dust login` first.");
        return;
      }

      const useFsServerRes = await useFileSystemServer(
        dustClient,
        (serverId) => {
          setFileSystemServerId(serverId);
        },
        requestDiffApproval
      );
      if (useFsServerRes.isErr()) {
        setError(useFsServerRes.error.message);
      }
    })();
  }, [selectedAgent, fileSystemInitialized, requestDiffApproval]);

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
        setError("Authentication required. Run `dust login` first.");
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

  const canSubmit =
    me &&
    !meError &&
    !isMeLoading &&
    !isProcessingQuestion &&
    !inlineSelector &&
    !!userInput.trim();

  const handleSubmitQuestion = useCallback(
    async (questionText: string, attachedFiles: UploadedFile[] = []) => {
      if (!selectedAgent || !me || meError || isMeLoading) {
        return;
      }

      // questionText is what's shown in the transcript - it may still
      // contain "[Pasted N lines of text]" placeholders. fullQuestionText
      // swaps those back in for what actually gets sent to the agent.
      let fullQuestionText = questionText;
      for (const { placeholder, content } of pastedBlocksRef.current) {
        if (fullQuestionText.includes(placeholder)) {
          fullQuestionText = fullQuestionText.replace(placeholder, content);
        }
      }
      pastedBlocksRef.current = [];

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
            content: questionText,
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

      const dustClientRes = await getDustClient();
      if (dustClientRes.isErr()) {
        setError(dustClientRes.error.message);
        return;
      }

      const dustClient = dustClientRes.value;
      if (!dustClient) {
        setError("Authentication required. Run `dust login` first.");
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
        return `\n\nTo resume this conversation, run:\ndustw${agentFlag} --resume ${conversation.sId}`;
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
            title: `CLI Question: ${fullQuestionText.substring(0, 30)}${
              fullQuestionText.length > 30 ? "..." : ""
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
        const streamRes = await retryResult(() =>
          dustClient.streamAgentAnswerEvents({
            conversation: conversation,
            userMessageId: userMessageId,
            signal: controller.signal, // Add the abort signal
          })
        );

        if (streamRes.isErr()) {
          throw new Error(
            `Failed to stream agent answer: ${streamRes.error.message}`
          );
        }

        updateIntervalRef.current = setInterval(() => {
          updateThinkingPreview();
          setStreamingContentPreview(
            renderMarkdownSegments(contentRef.current)
          );
        }, 1000);

        for await (const event of streamRes.value.eventStream) {
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
            contentRef.current = contentRef.current || "[Cancelled]";
            pushFinalContentToConversationItems();
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
          } else if (event.type === "agent_action_success") {
            setActionStatus(null);
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

          setConversationItems((prev) => {
            const lastAgentMessageHeader = getLastConversationItem<
              ConversationItem & { type: "agent_message_header" }
            >(prev, "agent_message_header");

            if (!lastAgentMessageHeader) {
              throw new Error("Unreachable: No agent message header found");
            }

            return [
              ...prev,
              {
                key: `agent_message_cancelled_${lastAgentMessageHeader.index}`,
                type: "agent_message_cancelled",
              },
            ];
          });

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
    ]
  );

  // Handle file upload completion
  const handleFileUploadComplete = useCallback(
    (files: UploadedFile[]) => {
      setUploadedFiles(files);
      setIsUploadingFiles(false);
      setPendingFiles([]);

      // If there's a message waiting to be sent with these files, send it now
      if (userInput.trim()) {
        void handleSubmitQuestion(userInput, files);
        setUserInput("");
        setCursorPosition(0);
      }
    },
    [userInput, handleSubmitQuestion]
  );

  // Handle file upload error
  const handleFileUploadError = useCallback((error: string) => {
    setError(error);
    setIsUploadingFiles(false);
    setPendingFiles([]);
  }, []);

  // Handle keyboard events.
  useInput((input, key) => {
    // Ctrl+C: cancel an in-flight generation immediately (mirrors ESC), but
    // never exit the whole session on a single accidental press while idle
    // — require a second press within 2s, with a visible hint in between.
    // (Ink's default exitOnCtrlC is disabled in index.tsx for this reason.)
    if (key.ctrl && input === "c") {
      if (isProcessingQuestion && abortController) {
        abortController.abort();
        return;
      }
      const now = Date.now();
      if (now - lastCtrlCTimeRef.current < 2000) {
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
        } else {
          setInlineSelector(null);
        }
        return;
      }

      const isFixedMode =
        inlineSelector.mode === "approval" || inlineSelector.mode === "diff";
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

      if (key.downArrow) {
        const filteredCommands = commands.filter((cmd) =>
          cmd.name.toLowerCase().startsWith(commandQuery.toLowerCase())
        );
        setSelectedCommandIndex((prev) =>
          Math.min(filteredCommands.length - 1, prev + 1)
        );
        return;
      }

      if (key.return) {
        const filteredCommands = commands.filter((cmd) =>
          cmd.name.toLowerCase().startsWith(commandQuery.toLowerCase())
        );
        if (
          filteredCommands.length > 0 &&
          selectedCommandIndex < filteredCommands.length
        ) {
          const selectedCommand = filteredCommands[selectedCommandIndex];
          void selectedCommand.execute({ triggerAgentSwitch });
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
      if (key.tab && !key.shift) {
        const filteredCommands = commands.filter((cmd) =>
          cmd.name.toLowerCase().startsWith(commandQuery.toLowerCase())
        );
        if (
          filteredCommands.length > 0 &&
          selectedCommandIndex < filteredCommands.length
        ) {
          const selectedCommand = filteredCommands[selectedCommandIndex];
          setCommandQuery(selectedCommand.name);
          setCommandCursorPosition(selectedCommand.name.length);
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

    // Shift+Tab to toggle auto-approval mode
    if (key.tab && key.shift) {
      setAutoAcceptEdits((prev) => !prev);
      return;
    }

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
      process.platform === "win32"
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
      if (isProcessingQuestion && abortController) {
        abortController.abort();
      } else if (userInput) {
        setUserInput("");
        setCursorPosition(0);
        pastedBlocksRef.current = [];
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

      // Only allow submission if not processing, "me" is loaded and user input is not empty
      if (!canSubmit) {
        return;
      }

      // No files, send message immediately
      void handleSubmitQuestion(userInput, uploadedFiles);
      setUserInput("");
      setCursorPosition(0);
      setUploadedFiles([]); // Clear uploaded files after sending

      return;
    }

    // Ctrl+Backspace / Ctrl+W: delete the previous word (mirrors readline's
    // unix-word-rubout binding). Ctrl+Backspace's exact reported key shape
    // varies by terminal, so both are supported; Ctrl+W is the reliable,
    // terminal-agnostic fallback.
    if (
      currentCursorPos > 0 &&
      key.ctrl &&
      ((key.backspace || key.delete) || input === "w")
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

    if (key.backspace || key.delete) {
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

    // Regular arrow key handling (left/right for character movement)
    if (key.leftArrow && currentCursorPos > 0) {
      setCurrentCursorPos(currentCursorPos - 1);
      return;
    }

    if (key.rightArrow && currentCursorPos < currentInput.length) {
      setCurrentCursorPos(currentCursorPos + 1);
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
          <Text color="green">Loading...</Text>
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
          setConversationItems([
            {
              key: "welcome_header",
              type: "welcome_header",
              agentName: agents[0].name,
              agentDescription: agents[0].description,
            },
          ]);
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
        conversationItems={conversationItems}
        isProcessingQuestion={isProcessingQuestion}
        actionStatus={actionStatus}
        thinkingPreview={thinkingPreview}
        streamingContentPreview={streamingContentPreview}
        showExitHint={showExitHint}
        agentName={selectedAgent?.name ?? null}
        workspaceName={workspaceName}
        consumedCredits={consumedCredits}
        contextUsage={contextUsage}
        userInput={inlineSelector ? inlineSelector.query : userInput}
        cursorPosition={
          inlineSelector ? inlineSelector.query.length : cursorPosition
        }
        mentionPrefix={
          inlineSelector
            ? inlineSelector.mode === "agent"
              ? "Switch agent: "
              : inlineSelector.mode === "file"
                ? `📁 ${inlineSelector.currentPath ?? ""} `
                : inlineSelector.mode === "conversation"
                  ? "Resume conversation: "
                  : inlineSelector.mode === "approval" &&
                      pendingApproval &&
                      pendingApproval.type === "tool_approve_execution"
                    ? `Tool Approval Required: the agent wants to use ${pendingApproval.metadata.toolName}, what do you want to do? `
                    : inlineSelector.mode === "diff" && pendingDiffApproval
                      ? `Changes Preview: ${pendingDiffApproval.filePath} `
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
        autoAcceptEdits={autoAcceptEdits}
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
                      : inlineSelector.mode === "conversation"
                        ? "Select a conversation:"
                        : inlineSelector.mode === "approval" ||
                            inlineSelector.mode === "diff"
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
                      {renderDiffLines(pendingDiffApproval)}
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
