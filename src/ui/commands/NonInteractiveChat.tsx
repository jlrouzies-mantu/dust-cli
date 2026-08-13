import { Box, Text } from "ink";
import type { FC } from "react";
import React, { useEffect, useState } from "react";

import { useFileSystemServer } from "../../mcp/servers/fsServer.js";
import { getDustClient } from "../../utils/dustClient.js";
import { normalizeError } from "../../utils/errors.js";
import {
  DEFAULT_MAX_LOOP_RUNS,
  MAX_LOOP_RUNS_CEILING,
  parseInterval,
} from "../../utils/loopController.js";
import {
  fetchAgentMessageFromConversation,
  runNonInteractiveLoop,
  sendNonInteractiveMessage,
  validateNonInteractiveFlags,
} from "./chat/nonInteractive.js";

interface NonInteractiveChatProps {
  agentSearch?: string;
  message?: string;
  conversationId?: string;
  messageId?: string;
  details?: boolean;
  projectName?: string;
  projectId?: string;
  withTools?: boolean;
  loop?: string;
  maxRuns?: number;
  loopFreshConversation?: boolean;
}

const NonInteractiveChat: FC<NonInteractiveChatProps> = ({
  agentSearch,
  message,
  conversationId,
  messageId,
  details,
  projectName,
  projectId,
  withTools,
  loop,
  maxRuns,
  loopFreshConversation,
}) => {
  const [error, setError] = useState<string | null>(null);

  // Handle all non-interactive operations with fail-fast validation
  useEffect(() => {
    async function handleNonInteractive() {
      // Validate flags first - fail fast before any side effects
      const validationError = validateNonInteractiveFlags(
        message,
        agentSearch,
        conversationId,
        messageId,
        details,
        projectName,
        projectId
      );
      if (validationError) {
        setError(validationError);
        return;
      }

      // --loop validation happens up front, alongside the other flag checks:
      // a bad interval or run cap must fail before any message is sent, not
      // after the first run has already spent credits.
      let loopConfig: { intervalMs: number; maxRuns: number } | null = null;
      if (loop !== undefined) {
        if (!message) {
          setError("Invalid usage: --loop requires --message");
          return;
        }
        if (messageId) {
          setError("Invalid usage: --loop cannot be used with --messageId");
          return;
        }
        const interval = parseInterval(loop);
        if (!interval.ok) {
          setError(`Invalid --loop value: ${interval.error}`);
          return;
        }
        const runs = maxRuns ?? DEFAULT_MAX_LOOP_RUNS;
        if (!Number.isInteger(runs) || runs < 1 || runs > MAX_LOOP_RUNS_CEILING) {
          setError(
            `Invalid --maxRuns value: must be a whole number between 1 and ${MAX_LOOP_RUNS_CEILING}`
          );
          return;
        }
        loopConfig = { intervalMs: interval.value, maxRuns: runs };
      } else if (maxRuns !== undefined || loopFreshConversation) {
        setError(
          "Invalid usage: --maxRuns and --loopFreshConversation require --loop"
        );
        return;
      }

      try {
        // Handle messageId mode - fetch agent message from conversation
        if (messageId && conversationId) {
          await fetchAgentMessageFromConversation(
            conversationId,
            messageId,
            setError
          );
          return;
        }

        // Handle agent search and message sending
        if (!message || !agentSearch) {
          return;
        }

        // Get dust client
        const dustClientRes = await getDustClient();
        if (dustClientRes.isErr()) {
          setError(
            "Authentication Error: Try re-logging in by running `dustm logout` and `dustm login`"
          );
          return;
        }

        const dustClient = dustClientRes.value;
        if (!dustClient) {
          setError("Authentication required: Run `dustm login` first");
          return;
        }

        // Get current user info
        const meRes = await dustClient.me();
        if (meRes.isErr()) {
          setError(`Authentication error: ${meRes.error.message}`);
          return;
        }
        const me = meRes.value;

        // Get all agents
        const agentsRes = await dustClient.getAgentConfigurations({});
        if (agentsRes.isErr()) {
          setError(`Failed to load agents: ${agentsRes.error.message}`);
          return;
        }

        const allAgents = agentsRes.value;
        if (!allAgents || allAgents.length === 0) {
          setError("No agents available: No agents found for the current user");
          return;
        }

        // Search for agents matching the search string (case-insensitive)
        const searchLower = agentSearch.toLowerCase();
        const matchingAgents = allAgents.filter((agent) =>
          agent.name.toLowerCase().startsWith(searchLower)
        );

        if (matchingAgents.length === 0) {
          setError(`Agent not found: No agent found matching "${agentSearch}"`);
          return;
        }

        let selectedAgent = matchingAgents[0];
        if (matchingAgents.length > 1) {
          const exactMatches = matchingAgents.filter(
            (agent) => agent.name.toLowerCase() === searchLower
          );

          if (exactMatches.length === 1) {
            selectedAgent = exactMatches[0];
            console.warn(
              `Multiple agents matched "${agentSearch}". Using exact match "${selectedAgent.name}" among: ${matchingAgents
                .map((agent) => agent.name)
                .join(", ")}`
            );
          } else {
            setError(
              `Multiple agents found: Multiple agents match "${agentSearch}": ${matchingAgents
                .map((a) => a.name)
                .join(", ")}`
            );
            return;
          }
        }

        // Initialize file system MCP server if requested
        let fileSystemServerId: string | undefined;
        if (withTools) {
          const fsResult = await useFileSystemServer(dustClient, (serverId) => {
            fileSystemServerId = serverId;
          });
          if (fsResult.isErr()) {
            setError(
              `Failed to initialize file system tools: ${fsResult.error.message}`
            );
            return;
          }
        }

        if (loopConfig) {
          await runNonInteractiveLoop(
            message,
            selectedAgent,
            me,
            { ...loopConfig, freshConversation: loopFreshConversation },
            conversationId,
            details,
            projectName,
            projectId,
            setError,
            fileSystemServerId
          );
          return;
        }

        // Call the standalone function
        await sendNonInteractiveMessage(
          message,
          selectedAgent,
          me,
          conversationId,
          details,
          projectName,
          projectId,
          setError,
          fileSystemServerId
        );
      } catch (error) {
        setError(`Unexpected error: ${normalizeError(error).message}`);
      }
    }

    void handleNonInteractive();
  }, [
    message,
    agentSearch,
    conversationId,
    messageId,
    details,
    projectName,
    projectId,
    withTools,
    loop,
    maxRuns,
    loopFreshConversation,
  ]);

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  // Don't render anything in success cases - all output is handled via console.log
  return null;
};

export default NonInteractiveChat;
