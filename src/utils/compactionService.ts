import AuthService from "./authService.js";
import { getApiDomain } from "./dustClient.js";
import type { ProviderId } from "./modelSelection.js";
import TokenStorage from "./tokenStorage.js";

/**
 * Conversation compaction - the server-side operation behind `/compact`.
 *
 * Dust summarizes everything before a point in the conversation into a
 * single `compaction_message`, which is what subsequent turns carry instead
 * of the full history. It is genuinely server-side: this CLI can't usefully
 * fake it, because the conversation history lives on Dust's side and the
 * agent's next turn is assembled there.
 *
 * Two things shape this module:
 *
 * 1. It is a private endpoint. `POST /api/w/{wId}/assistant/conversations/
 *    {cId}/compactions` is not under `/api/v1`, has no SDK method
 *    (`@dust-tt/client` contains no reference to compaction at all as of
 *    1.2.8 - which is npm-latest, not a stale pin), and Dust has not
 *    committed to supporting it for external clients. Same standing as the
 *    context-usage and credits endpoints this fork already calls, and the
 *    same AuthService-based auth: a headless `DUST_API_KEY` workspace key
 *    cannot reach these, only a real `dustm login` session can.
 *
 * 2. Completion is asynchronous and this CLI is on the wrong stream. The
 *    web app learns a compaction finished from a `compaction_message_done`
 *    event on the conversation-wide SSE stream; this CLI subscribes to
 *    `streamAgentAnswerEvents` (per agent message) instead, so it would
 *    never see it. Rather than open a second stream just for this, the
 *    compaction message's own status is polled - it is created
 *    synchronously when the request is accepted, so it is there to read
 *    from the first poll onward.
 *
 *    Note *where* it's polled from. The public v1 conversation endpoint
 *    does not return compaction messages at all - verified live: a
 *    conversation whose compaction had succeeded still came back with only
 *    user_message/agent_message in `content`. The private
 *    `.../conversations/{cId}/messages` endpoint does return them, with
 *    their status and summary, so that is what's polled. (This is also why
 *    `dustClient.getConversation()` is safe to keep using everywhere else,
 *    despite the SDK's ConversationSchema having no idea the type exists:
 *    the endpoint it calls never hands it one.)
 */

// The server's CompactionMessageStatus lifecycle is created -> succeeded |
// failed. Statuses are compared as plain strings rather than typed against
// that union, since it's an undocumented shape and an unrecognised value
// should leave the poll waiting rather than be treated as terminal.
export interface CompactionModel {
  providerId: ProviderId;
  modelId: string;
}

export type CompactionStartResult =
  | { ok: true; compactionMessageId: string }
  | { ok: false; message: string; detail?: string };

/**
 * Fires the compaction request. Returns as soon as the server has accepted
 * it and created the compaction message - the summarization itself runs in
 * a workflow afterwards, so the caller still has to wait (see
 * waitForCompaction).
 */
export async function startCompaction({
  conversationId,
  model,
}: {
  conversationId: string;
  model: CompactionModel;
}): Promise<CompactionStartResult> {
  const accessTokenRes = await AuthService.getValidAccessToken();
  if (accessTokenRes.isErr() || !accessTokenRes.value) {
    return {
      ok: false,
      message: "Not signed in.",
      detail: "Compaction needs a `dustm login` session, not an API key.",
    };
  }

  const workspaceId = await AuthService.getSelectedWorkspaceId();
  if (!workspaceId) {
    return { ok: false, message: "No workspace selected." };
  }

  const region = await TokenStorage.getRegion();
  const apiDomainRes = getApiDomain(region);
  if (apiDomainRes.isErr()) {
    return { ok: false, message: "Could not resolve the Dust API domain." };
  }

  let res: Response;
  try {
    res = await fetch(
      `${apiDomainRes.value}/api/w/${workspaceId}/assistant/conversations/${conversationId}/compactions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessTokenRes.value}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: { providerId: model.providerId, modelId: model.modelId },
        }),
      }
    );
  } catch (e) {
    return {
      ok: false,
      message: "Could not reach the compaction endpoint.",
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  if (!res.ok) {
    // The server's own wording beats anything invented here: the three 409s
    // in particular ("Answer the pending agent message first", "A compaction
    // is already in progress", "This conversation was just compacted") each
    // name a different thing for the user to do next.
    const serverMessage = await readApiErrorMessage(res);
    if (res.status === 404) {
      return { ok: false, message: serverMessage ?? "Conversation not found." };
    }
    if (res.status === 409) {
      return { ok: false, message: serverMessage ?? "Compaction unavailable." };
    }
    if (res.status === 400) {
      return {
        ok: false,
        message: serverMessage ?? `Model rejected: ${model.modelId}.`,
        detail: "Pick another with /compact <model-id>.",
      };
    }
    return {
      ok: false,
      message: `Compaction failed (HTTP ${res.status}).`,
      detail:
        serverMessage ??
        "This is an undocumented endpoint - it may have changed or been withdrawn.",
    };
  }

  const body = (await res.json().catch(() => null)) as {
    compactionMessage?: { sId?: unknown };
  } | null;
  const sId = body?.compactionMessage?.sId;
  if (typeof sId !== "string") {
    return {
      ok: false,
      message: "Compaction started, but the server's reply wasn't understood.",
    };
  }

  return { ok: true, compactionMessageId: sId };
}

async function readApiErrorMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    const message = body?.error?.message;
    return typeof message === "string" && message.length > 0 ? message : null;
  } catch {
    return null;
  }
}

export type CompactionOutcome =
  | { status: "succeeded"; summary: string | null }
  | { status: "failed" }
  | { status: "timeout" };

/**
 * Reads one compaction message's current status from the private messages
 * endpoint.
 *
 * Only the newest few messages are requested: that endpoint pages backwards
 * from the end (its `lastValue` cursor is the rank of the *first* message
 * returned, and paging passes it back as `lastRank`), so an unpaged call
 * returns the most recent messages - and a compaction message is created at
 * the next free rank, with the server refusing to start one while an agent
 * message is in flight. It is therefore always within the last handful.
 */
async function fetchCompactionStatus(
  conversationId: string,
  compactionMessageId: string,
  signal?: AbortSignal
): Promise<{ status: string; content: string | null } | null> {
  try {
    const accessTokenRes = await AuthService.getValidAccessToken();
    if (accessTokenRes.isErr() || !accessTokenRes.value) {
      return null;
    }
    const workspaceId = await AuthService.getSelectedWorkspaceId();
    if (!workspaceId) {
      return null;
    }
    const region = await TokenStorage.getRegion();
    const apiDomainRes = getApiDomain(region);
    if (apiDomainRes.isErr()) {
      return null;
    }

    const res = await fetch(
      `${apiDomainRes.value}/api/w/${workspaceId}/assistant/conversations/${conversationId}/messages?limit=8`,
      { headers: { Authorization: `Bearer ${accessTokenRes.value}` }, signal }
    );
    if (!res.ok) {
      return null;
    }

    const body = (await res.json()) as { messages?: unknown };
    if (!Array.isArray(body.messages)) {
      return null;
    }
    for (const raw of body.messages) {
      if (typeof raw !== "object" || raw === null) {
        continue;
      }
      const m = raw as Record<string, unknown>;
      if (m.type !== "compaction_message" || m.sId !== compactionMessageId) {
        continue;
      }
      return {
        status: typeof m.status === "string" ? m.status : "unknown",
        content: typeof m.content === "string" ? m.content : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Polls until the compaction message reaches a terminal status. */
export async function waitForCompaction({
  conversationId,
  compactionMessageId,
  timeoutMs = 5 * 60 * 1000,
  pollIntervalMs = 2000,
  signal,
}: {
  conversationId: string;
  compactionMessageId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}): Promise<CompactionOutcome> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      return { status: "timeout" };
    }
    await sleep(pollIntervalMs, signal);

    const message = await fetchCompactionStatus(
      conversationId,
      compactionMessageId,
      signal
    );
    if (!message) {
      // A transient failure shouldn't end the wait - the compaction runs
      // server-side regardless of whether we could read its status.
      continue;
    }
    if (message.status === "succeeded") {
      return { status: "succeeded", summary: message.content };
    }
    if (message.status === "failed") {
      return { status: "failed" };
    }
  }

  return { status: "timeout" };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
