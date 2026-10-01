import type { ConversationPublicType } from "@dust-tt/client";

import { getDustClient } from "./dustClient.js";
import { normalizeError } from "./errors.js";
import type { ModelSelectionPayload } from "./modelSelection.js";

/**
 * `/btw <question>` - a quick side question that never becomes part of the
 * main conversation (Claude Code's `/btw`).
 *
 * Dust has no notion of an "ephemeral" message: anything posted into a
 * conversation is history every later turn carries. So the question goes to
 * the same agent in a **separate, unlisted conversation**, primed with an
 * excerpt of the main one so it can actually answer questions about it. The
 * main conversation never sees the question or the answer, and since it's a
 * different conversation it can be asked while the main turn is still
 * running - which is the point of the command.
 *
 * Deliberately sent with no client-side MCP servers (no local file/command
 * tools) and with every server-side tool approval rejected: a side question
 * is read-only by construction, which also means it needs no plan-mode
 * gating. The cost is one extra agent message on the credit balance.
 *
 * There is no public endpoint to delete a conversation, so the side
 * conversation stays behind - unlisted, like every conversation this CLI
 * creates.
 */

// Bounds on how much of the main conversation is replayed as context. The
// newest turns are kept first; each message is clipped on its own so one
// huge answer (a pasted log, a generated file) can't crowd out the rest.
const MAX_CONTEXT_CHARS = 24_000;
const MAX_MESSAGE_CHARS = 6_000;

export interface BtwTurn {
  role: "user" | "agent";
  text: string;
}

function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  // Keep both ends: an answer's conclusion is usually at the bottom, a
  // question's intent at the top.
  const half = Math.floor((max - 20) / 2);
  return `${text.slice(0, half)}\n[… clipped …]\n${text.slice(-half)}`;
}

/**
 * Flattens a conversation into user/agent turns, newest last. Uses the
 * latest version of each message (a retried answer replaces the earlier
 * one). An agent message still being generated has no final content
 * server-side yet - `inFlightAnswer` (what the CLI has streamed so far)
 * stands in for it.
 */
export function extractBtwTranscript(
  conversation: ConversationPublicType | null,
  inFlightAnswer?: string
): BtwTurn[] {
  const turns: BtwTurn[] = [];
  let sawInFlight = false;
  for (const versions of conversation?.content ?? []) {
    const message = versions[versions.length - 1];
    if (!message) {
      continue;
    }
    if (message.type === "user_message") {
      if (message.content.trim()) {
        turns.push({ role: "user", text: message.content });
      }
    } else if (message.type === "agent_message") {
      if (message.status === "created" && inFlightAnswer) {
        turns.push({ role: "agent", text: inFlightAnswer });
        sawInFlight = true;
      } else if (message.content?.trim()) {
        turns.push({ role: "agent", text: message.content });
      }
    }
  }
  // The stream can be ahead of what the server reports, so the in-flight
  // answer may not have a message to attach to yet.
  if (inFlightAnswer?.trim() && !sawInFlight) {
    turns.push({ role: "agent", text: inFlightAnswer });
  }
  return turns;
}

/** Builds the side conversation's single message. Pure. */
export function buildBtwPrompt(question: string, turns: BtwTurn[]): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const block = `${turn.role === "user" ? "User" : "You"}: ${clip(
      turn.text.trim(),
      MAX_MESSAGE_CHARS
    )}`;
    if (used + block.length > MAX_CONTEXT_CHARS) {
      break;
    }
    kept.unshift(block);
    used += block.length;
  }
  const omitted = turns.length - kept.length;

  const intro =
    "This is a quick side question (\"by the way\") from the user, asked " +
    "while working with you in another conversation. Answer it directly " +
    "and concisely. Do not continue, redo or act on the main task, and do " +
    "not use tools unless the question cannot be answered without them.";

  if (kept.length === 0) {
    return `${intro}\n\nSide question: ${question}`;
  }
  return [
    intro,
    "",
    "For context, here is the main conversation so far" +
      (omitted > 0 ? ` (its ${omitted} oldest messages omitted)` : "") +
      ":",
    "<main_conversation>",
    kept.join("\n\n"),
    "</main_conversation>",
    "",
    `Side question: ${question}`,
  ].join("\n");
}

export type BtwResult =
  | { ok: true; answer: string; sideConversationId: string }
  | { ok: false; message: string };

export async function askBtw({
  question,
  agentId,
  mainConversationId,
  inFlightAnswer,
  user,
  modelSelection,
  spaceId,
  signal,
}: {
  question: string;
  agentId: string;
  mainConversationId: string | null;
  inFlightAnswer?: string;
  user: { username: string; fullName: string; email: string };
  modelSelection?: ModelSelectionPayload;
  spaceId?: string;
  signal?: AbortSignal;
}): Promise<BtwResult> {
  const clientRes = await getDustClient();
  if (clientRes.isErr()) {
    return { ok: false, message: clientRes.error.message };
  }
  const dustClient = clientRes.value;
  if (!dustClient) {
    return { ok: false, message: "Not authenticated - run `dustm login`." };
  }

  // Context is best-effort: a failed fetch degrades to a context-free
  // answer rather than refusing the question.
  let mainConversation: ConversationPublicType | null = null;
  if (mainConversationId) {
    const convRes = await dustClient.getConversation({
      conversationId: mainConversationId,
      signal,
    });
    if (convRes.isOk()) {
      mainConversation = convRes.value;
    }
  }
  const content = buildBtwPrompt(
    question,
    extractBtwTranscript(mainConversation, inFlightAnswer)
  );

  let sideConversationId: string | null = null;
  try {
    const convRes = await dustClient.createConversation({
      title: `btw: ${question.slice(0, 40)}${question.length > 40 ? "..." : ""}`,
      visibility: "unlisted",
      message: {
        content,
        mentions: [{ configurationId: agentId }],
        context: {
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          username: user.username,
          fullName: user.fullName,
          email: user.email,
          origin: "cli",
          clientSideMCPServerIds: null,
        },
        ...(modelSelection ? { modelSelection } : {}),
      },
      contentFragment: undefined,
      spaceId,
      signal,
    });
    if (convRes.isErr()) {
      return { ok: false, message: convRes.error.message };
    }
    const conversation = convRes.value.conversation;
    sideConversationId = conversation.sId;
    const userMessageId = convRes.value.message?.sId;
    if (!userMessageId) {
      return { ok: false, message: "No message was created." };
    }

    const streamRes = await dustClient.streamAgentAnswerEvents({
      conversation,
      userMessageId,
      signal,
    });
    if (streamRes.isErr()) {
      return { ok: false, message: streamRes.error.message };
    }

    let answer = "";
    for await (const event of streamRes.value.eventStream) {
      if (event.type === "generation_tokens") {
        if (event.classification === "tokens") {
          answer += event.text;
        }
      } else if (event.type === "tool_approve_execution") {
        await dustClient.validateAction({
          conversationId: event.conversationId,
          messageId: event.messageId,
          actionId: event.actionId,
          approved: "rejected",
        });
      } else if (event.type === "agent_error") {
        return { ok: false, message: event.error.message };
      } else if (event.type === "user_message_error") {
        return { ok: false, message: event.error.message };
      } else if (event.type === "agent_generation_cancelled") {
        return { ok: false, message: "Cancelled." };
      } else if (event.type === "agent_message_success") {
        return {
          ok: true,
          answer: event.message.content?.trim() || answer.trim(),
          sideConversationId,
        };
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      return { ok: false, message: "Cancelled." };
    }
    // Fall through to recovery below - the same @dust-tt/client SSE
    // "done"-sentinel failure the main chat recovers from can end this
    // stream with an error after the answer has already landed.
    const recovered = await recoverAnswer(sideConversationId);
    if (recovered && sideConversationId) {
      return { ok: true, answer: recovered, sideConversationId };
    }
    return { ok: false, message: normalizeError(error).message };
  }

  const recovered = await recoverAnswer(sideConversationId);
  if (recovered && sideConversationId) {
    return { ok: true, answer: recovered, sideConversationId };
  }
  return { ok: false, message: "The answer stream ended without an answer." };
}

async function recoverAnswer(
  conversationId: string | null
): Promise<string | null> {
  if (!conversationId) {
    return null;
  }
  const clientRes = await getDustClient();
  const dustClient = clientRes.isOk() ? clientRes.value : null;
  if (!dustClient) {
    return null;
  }
  const convRes = await dustClient.getConversation({ conversationId });
  if (convRes.isErr()) {
    return null;
  }
  const turns = extractBtwTranscript(convRes.value);
  const last = turns[turns.length - 1];
  return last?.role === "agent" ? last.text.trim() : null;
}
