import type {
  CreateConversationResponseType,
  DustAPI,
  GetAgentConfigurationsResponseType,
  MeResponseType,
} from "@dust-tt/client";

import { getDustClient } from "../../../utils/dustClient.js";
import { normalizeError } from "../../../utils/errors.js";
import { appendTranscriptEntry } from "../../../utils/transcriptStore.js";

type AgentConfiguration =
  GetAgentConfigurationsResponseType["agentConfigurations"][number];

/**
 * Validates project flags for interactive mode.
 * Returns an error message string if invalid, or null if valid.
 */
export function validateProjectFlags(
  projectName?: string,
  projectId?: string,
  conversationId?: string
): string | null {
  if (projectName && projectId) {
    return "Invalid usage: --projectName and --projectId cannot be used together";
  }

  if ((projectName || projectId) && conversationId) {
    return "Invalid usage: --projectName/--projectId cannot be used with --conversationId";
  }

  return null;
}

/**
 * Resolves a projectName or projectId to a spaceId.
 * - If projectId is provided, validates it exists.
 * - If projectName is provided, finds a matching space by name (case-insensitive).
 * - Returns undefined if neither is provided.
 * - Throws an error if the space is not found or multiple matches exist.
 */
export async function resolveSpaceId(
  dustClient: DustAPI,
  projectName?: string,
  projectId?: string
): Promise<string | undefined> {
  if (!projectName && !projectId) {
    return undefined;
  }

  const spacesRes = await dustClient.getSpaces();
  if (spacesRes.isErr()) {
    throw new Error(`Failed to fetch spaces: ${spacesRes.error.message}`);
  }

  const spaces = spacesRes.value;

  if (projectId) {
    const space = spaces.find((s) => s.sId === projectId);
    if (!space) {
      throw new Error(`Project with ID "${projectId}" not found`);
    }
    return space.sId;
  }

  if (projectName) {
    const searchLower = projectName.toLowerCase();
    const matchingSpaces = spaces.filter(
      (s) => s.name.toLowerCase() === searchLower
    );

    if (matchingSpaces.length === 0) {
      throw new Error(`Project with name "${projectName}" not found`);
    }

    if (matchingSpaces.length > 1) {
      throw new Error(
        `Multiple projects match name "${projectName}": ${matchingSpaces.map((s) => s.name).join(", ")}`
      );
    }

    return matchingSpaces[0].sId;
  }

  return undefined;
}

// Event types we handle in the code
interface BaseEvent {
  type: string;
  created?: number;
  [key: string]: unknown;
}

interface EventDetail extends BaseEvent {
  timestamp: number;
}

export interface NonInteractiveOutput {
  agentId: string;
  agentAnswer: string;
  conversationId: string;
  messageId: string;
  events?: EventDetail[];
  agentMessage?: unknown;
  cancelled?: boolean;
}

/**
 * Sends one message and prints the resulting JSON to stdout.
 *
 * By default this ends the process when the answer arrives, which is what a
 * plain `dustm chat -m "..."` invocation wants. Pass
 * `options.exitOnCompletion: false` to have it return the output instead -
 * needed by `--loop` (runNonInteractiveLoop below), which has to survive its
 * own first run in order to have a second one.
 */
export async function sendNonInteractiveMessage(
  message: string,
  selectedAgent: AgentConfiguration,
  me: MeResponseType["user"],
  existingConversationId?: string,
  showDetails?: boolean,
  projectName?: string,
  projectId?: string,
  setError?: (error: string) => void,
  fileSystemServerId?: string,
  options?: { exitOnCompletion?: boolean }
): Promise<NonInteractiveOutput | null> {
  // Default true, so the long-standing behaviour of every existing caller is
  // unchanged.
  const exitOnCompletion = options?.exitOnCompletion !== false;
  const dustClientRes = await getDustClient();
  if (dustClientRes.isErr()) {
    const errorMsg = `Failed to get client: ${dustClientRes.error.message}`;
    if (setError) {
      setError(errorMsg);
      return null;
    }
    process.exit(1);
  }

  const dustClient = dustClientRes.value;
  if (!dustClient) {
    const errorMsg = "Authentication required: Run `dustm login` first";
    if (setError) {
      setError(errorMsg);
      return null;
    }
    process.exit(1);
  }

  // Declared before the try block (rather than inside it) so the
  // crash-recovery fallback in the catch block below can still read the
  // conversation that was created/continued before the failure occurred.
  let conversation: CreateConversationResponseType["conversation"] | undefined;
  let userMessageId: string | undefined;

  // Before surfacing a fatal error, check whether the agent's answer
  // actually completed successfully server-side despite the client-side
  // failure (e.g. the known @dust-tt/client SSE "done"-sentinel bug that
  // exhausts its reconnect budget even though the answer already landed).
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

  try {
    // Resolve spaceId if projectName or projectId is provided
    let spaceId: string | undefined;
    try {
      spaceId = await resolveSpaceId(dustClient, projectName, projectId);
    } catch (error) {
      const errorMsg = normalizeError(error).message;
      if (setError) {
        setError(errorMsg);
        return null;
      }
      process.exit(1);
    }

    if (existingConversationId) {
      // Add message to existing conversation
      const messageRes = await dustClient.postUserMessage({
        conversationId: existingConversationId,
        message: {
          content: message,
          mentions: [{ configurationId: selectedAgent.sId }],
          context: {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            username: me.username,
            fullName: me.fullName,
            email: me.email,
            origin: "cli_programmatic",
            clientSideMCPServerIds: fileSystemServerId
              ? [fileSystemServerId]
              : null,
          },
        },
      });

      if (messageRes.isErr()) {
        const errorMsg = `Error adding message to conversation: ${messageRes.error.message}`;
        if (setError) {
          setError(errorMsg);
          return null;
        }
        process.exit(1);
      }

      userMessageId = messageRes.value.sId;

      // Get the conversation for streaming
      const convRes = await dustClient.getConversation({
        conversationId: existingConversationId,
      });
      if (convRes.isErr()) {
        const errorMsg = `Error retrieving conversation: ${convRes.error.message}`;
        if (setError) {
          setError(errorMsg);
          return null;
        }
        process.exit(1);
      }
      conversation = convRes.value;
    } else {
      // Create a new conversation with the agent
      const convRes = await dustClient.createConversation({
        title: message.substring(0, 50) + (message.length > 50 ? "..." : ""),
        visibility: "unlisted",
        message: {
          content: message,
          mentions: [{ configurationId: selectedAgent.sId }],
          context: {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            username: me.username,
            fullName: me.fullName,
            email: me.email,
            origin: "cli_programmatic",
            clientSideMCPServerIds: fileSystemServerId
              ? [fileSystemServerId]
              : null,
          },
        },
        contentFragment: undefined,
        spaceId,
      });

      if (convRes.isErr()) {
        const errorMsg = `Failed to create conversation: ${convRes.error.message}`;
        if (setError) {
          setError(errorMsg);
          return null;
        }
        process.exit(1);
      }

      conversation = convRes.value.conversation;
      const messageId = convRes.value.message?.sId;

      if (!messageId) {
        const errorMsg = "No message created";
        if (setError) {
          setError(errorMsg);
          return null;
        }
        process.exit(1);
      }

      userMessageId = messageId;
    }

    await appendTranscriptEntry(conversation.sId, {
      role: "user",
      text: message,
      messageId: userMessageId,
    });

    // Stream the agent's response
    const streamRes = await dustClient.streamAgentAnswerEvents({
      conversation: conversation,
      userMessageId: userMessageId,
    });

    if (streamRes.isErr()) {
      const errorMsg = `Failed to stream agent answer: ${streamRes.error.message}`;
      if (setError) {
        setError(errorMsg);
        return null;
      }
      process.exit(1);
    }

    let fullResponse = "";
    const eventDetails: EventDetail[] = [];

    for await (const event of streamRes.value.eventStream) {
      // If details flag is set, collect all events
      if (showDetails) {
        eventDetails.push({
          ...(event as BaseEvent),
          timestamp: Date.now(),
        });
      }

      if (event.type === "generation_tokens") {
        if (event.classification === "tokens") {
          fullResponse += event.text;
        }
      } else if (event.type === "agent_error") {
        const errorMsg = `Agent error: ${event.error.message}`;
        if (setError) {
          setError(errorMsg);
          return null;
        }
        process.exit(1);
      } else if (event.type === "user_message_error") {
        const errorMsg = `User message error: ${event.error.message}`;
        if (setError) {
          setError(errorMsg);
          return null;
        }
        process.exit(1);
      } else if (
        event.type === "tool_approve_execution" &&
        fileSystemServerId
      ) {
        // Auto-approve all tool executions: user explicitly opted in with --with-tools
        await dustClient.validateAction({
          conversationId: event.conversationId,
          messageId: event.messageId,
          actionId: event.actionId,
          approved: "approved",
        });
      } else if (event.type === "agent_generation_cancelled") {
        // Handle generation cancellation
        const output: NonInteractiveOutput = {
          agentId: selectedAgent.sId,
          agentAnswer:
            fullResponse.trim() || "[Message generation was cancelled]",
          conversationId: conversation.sId,
          messageId: event.messageId,
          cancelled: true,
        };

        // Add detailed event history if requested
        if (showDetails) {
          output.events = eventDetails;
        }

        if (!exitOnCompletion) {
          // A loop needs to see the cancellation to stop, so it is printed
          // and returned here. Note the exiting path below deliberately does
          // NOT print - that is long-standing behaviour for a cancelled
          // one-shot run, and changing what it writes to stdout is not this
          // change's business.
          console.log(JSON.stringify(output));
          return output;
        }

        // Exit with special code to indicate cancellation
        process.exit(2);
      } else if (event.type === "agent_message_success") {
        // Success - output the result
        const output: NonInteractiveOutput = {
          agentId: selectedAgent.sId,
          agentAnswer: fullResponse.trim(),
          conversationId: conversation.sId,
          messageId: event.message.sId,
        };

        await appendTranscriptEntry(conversation.sId, {
          role: "agent",
          text: output.agentAnswer,
          messageId: event.message.sId,
        });

        // Add detailed event history if requested
        if (showDetails) {
          output.events = eventDetails;
          output.agentMessage = event.message;
        }

        console.log(JSON.stringify(output));
        if (!exitOnCompletion) {
          return output;
        }
        process.exit(0);
      }
    }
  } catch (error) {
    const recoveredText = await tryRecoverAgentAnswer();
    if (recoveredText && conversation) {
      const output: NonInteractiveOutput = {
        agentId: selectedAgent.sId,
        agentAnswer: recoveredText.trim(),
        conversationId: conversation.sId,
        messageId: userMessageId ?? "",
      };
      await appendTranscriptEntry(conversation.sId, {
        role: "agent",
        text: output.agentAnswer,
      });
      console.log(JSON.stringify(output));
      if (!exitOnCompletion) {
        return output;
      }
      process.exit(0);
    }

    const conversationSuffix = conversation
      ? `\n\nTo resume this conversation, run:\ndustm --agent "${selectedAgent.name}" --resume ${conversation.sId}`
      : "";
    const errorMsg = `Unexpected error: ${normalizeError(error).message}${conversationSuffix}`;
    if (setError) {
      setError(errorMsg);
      return null;
    }
    process.exit(1);
  }

  // Reached only if the event stream ended without ever emitting
  // agent_message_success or agent_generation_cancelled - i.e. no answer
  // arrived and nothing threw. Previously this fell off the end of a
  // void-returning function; it now reports "no result" so a --loop run can
  // treat it as a failed iteration rather than a successful empty one.
  return null;
}

/**
 * Runs one prompt repeatedly on an interval, headless - the `--loop` form of
 * `/loop`, for CI and unattended use.
 *
 * Runs strictly sequentially: the next iteration starts only after the
 * previous answer has arrived, then waits out the interval. There is
 * deliberately no overlap and no catch-up for time spent waiting on the
 * agent, so a slow turn delays the schedule instead of stacking requests -
 * the same rule the interactive loop enforces by skipping ticks.
 *
 * One JSON object is printed per run (by sendNonInteractiveMessage), so the
 * output stays parseable line by line.
 */
export async function runNonInteractiveLoop(
  message: string,
  selectedAgent: AgentConfiguration,
  me: MeResponseType["user"],
  loop: {
    intervalMs: number;
    maxRuns: number;
    // When false (the default) every run continues the same conversation, so
    // the agent accumulates context across iterations - which is what makes
    // "check CI and fix what's broken" converge instead of restarting from
    // nothing each time.
    freshConversation?: boolean;
  },
  existingConversationId?: string,
  showDetails?: boolean,
  projectName?: string,
  projectId?: string,
  setError?: (error: string) => void,
  fileSystemServerId?: string
): Promise<void> {
  let conversationId = existingConversationId;

  for (let run = 1; run <= loop.maxRuns; run++) {
    const result = await sendNonInteractiveMessage(
      message,
      selectedAgent,
      me,
      loop.freshConversation ? undefined : conversationId,
      showDetails,
      projectName,
      projectId,
      setError,
      fileSystemServerId,
      { exitOnCompletion: false }
    );

    // No result means the run failed or the answer never arrived; setError
    // has already reported it. Stopping rather than retrying is deliberate -
    // an unattended loop that keeps hammering a failing endpoint is worse
    // than one that stops and leaves the error on screen.
    if (!result) {
      process.exit(1);
    }

    if (result.cancelled) {
      process.exit(2);
    }

    conversationId = result.conversationId;

    if (run < loop.maxRuns) {
      await new Promise((resolve) => setTimeout(resolve, loop.intervalMs));
    }
  }

  process.exit(0);
}

/**
 * Validates non-interactive flag combinations.
 * Returns an error message string if invalid, or null if valid.
 */
export function validateNonInteractiveFlags(
  message?: string,
  agentSearch?: string,
  conversationId?: string,
  messageId?: string,
  details?: boolean,
  projectName?: string,
  projectId?: string
): string | null {
  // Check --projectName and --projectId mutual exclusivity
  if (projectName && projectId) {
    return "Invalid usage: --projectName and --projectId cannot be used together";
  }

  // Check --projectName/--projectId exclusivity with --conversationId
  if ((projectName || projectId) && conversationId) {
    return "Invalid usage: --projectName/--projectId cannot be used with --conversationId";
  }

  // Check --messageId requirements
  if (messageId && !conversationId) {
    return "Invalid usage: --messageId requires --conversationId to be specified";
  }

  // Check --messageId exclusivity with other flags
  if (messageId && (agentSearch || message)) {
    return "Invalid usage: --messageId cannot be used with --agent or --message";
  }

  // Check --details requirements
  if (details && (!agentSearch || !message)) {
    return "Invalid usage: --details requires both --agent and --message to be specified";
  }

  // Existing validations
  if (message && !agentSearch) {
    return "Invalid usage: --message requires --agent to be specified";
  }

  if (conversationId && !messageId && (!agentSearch || !message)) {
    return "Invalid usage: --conversationId requires both --agent and --message to be specified (or --messageId)";
  }

  return null;
}

export async function fetchAgentMessageFromConversation(
  conversationId: string,
  messageId: string,
  setError?: (error: string) => void
): Promise<void> {
  const dustClientRes = await getDustClient();
  if (dustClientRes.isErr()) {
    const errorMsg = `Failed to get client: ${dustClientRes.error.message}`;
    if (setError) {
      setError(errorMsg);
      return;
    }
    process.exit(1);
  }

  const dustClient = dustClientRes.value;
  if (!dustClient) {
    const errorMsg = "Authentication required: Run `dustm login` first";
    if (setError) {
      setError(errorMsg);
      return;
    }
    process.exit(1);
  }

  try {
    // Get conversation with messages
    const convRes = await dustClient.getConversation({
      conversationId: conversationId,
    });

    if (convRes.isErr()) {
      const errorMsg = `Failed to fetch conversation: ${convRes.error.message}`;
      if (setError) {
        setError(errorMsg);
        return;
      }
      process.exit(1);
    }

    const conversation = convRes.value;

    // Find the agent message with the specified sId
    let agentMessage = null;
    for (const contentGroup of conversation.content) {
      for (const msg of contentGroup) {
        if (msg.type === "agent_message" && msg.sId === messageId) {
          agentMessage = msg;
          break;
        }
      }
      if (agentMessage) {
        break;
      }
    }

    if (!agentMessage) {
      const errorMsg = `Message not found: Agent message with ID ${messageId} not found in conversation ${conversationId}`;
      if (setError) {
        setError(errorMsg);
        return;
      }
      process.exit(1);
    }

    // Output the agent message as JSON
    console.log(JSON.stringify(agentMessage));
    process.exit(0);
  } catch (error) {
    const errorMsg = `Unexpected error: ${normalizeError(error).message}`;
    if (setError) {
      setError(errorMsg);
      return;
    }
    process.exit(1);
  }
}
