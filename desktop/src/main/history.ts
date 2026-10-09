import AuthService from "../../../src/utils/authService";
import { getApiDomain } from "../../../src/utils/dustClient";
import TokenStorage from "../../../src/utils/tokenStorage";
import type { TranscriptItem } from "../shared/ipc";
import { newId } from "./transcript";

/**
 * Windowed history for opening a conversation.
 *
 * Why this exists (profiled, see the 2026-10 "opening is slow" bug): the
 * public `getConversation` returns *every* message with its tool outputs. One
 * real conversation of 150 messages was an 11 MB response, 2-5 s on the wire,
 * before any parsing or rendering; building the items and the IPC hand-off
 * were each under 40 ms. So the cost is the size of the download, and the fix
 * is to not download all of it.
 *
 * The private messages endpoint (same standing as contextUsage.ts and
 * compactionService.ts: not public, no SDK support, may change) returns the
 * newest N messages and pages backwards with `lastValue=<rank>`. The same
 * conversation's last 30 messages are about 360 KB in about 0.5 s.
 *
 * Every failure (shape change, HTTP error) returns null and the caller falls
 * back to the public full load, so this can only make things faster.
 */

export interface HistoryPage {
  items: TranscriptItem[];
  hasMore: boolean;
  /** Rank of the oldest message returned; pass it to fetch the page before. */
  cursor: number | null;
}

interface RawMessage {
  type?: unknown;
  rank?: unknown;
  version?: unknown;
  visibility?: unknown;
  content?: unknown;
  title?: unknown;
  configuration?: { name?: unknown };
  status?: unknown;
}

interface PrivateAuth {
  token: string;
  base: string;
}

/**
 * Credentials for the private (non-v1) endpoints. Null under a workspace API
 * key (`sk-`, the headless DUST_API_KEY setup): those endpoints take a user
 * session, so the caller goes straight to its public fallback instead of
 * spending a round trip on a guaranteed 401.
 */
async function privateAuth(): Promise<PrivateAuth | null> {
  const token = await AuthService.getValidAccessToken();
  if (token.isErr() || !token.value || token.value.startsWith("sk-")) {
    return null;
  }
  const workspaceId = await AuthService.getSelectedWorkspaceId();
  const domain = getApiDomain(await TokenStorage.getRegion());
  if (!workspaceId || domain.isErr()) {
    return null;
  }
  return {
    token: token.value,
    base: `${domain.value}/api/w/${encodeURIComponent(workspaceId)}/assistant/conversations`,
  };
}

export async function fetchHistoryPage(
  conversationId: string,
  options: { limit: number; beforeRank?: number | null; agentName: string }
): Promise<HistoryPage | null> {
  try {
    const auth = await privateAuth();
    if (!auth) {
      return null;
    }
    const params = new URLSearchParams({ limit: String(options.limit) });
    if (options.beforeRank != null) {
      params.set("lastValue", String(options.beforeRank));
    }
    const res = await fetch(
      `${auth.base}/${encodeURIComponent(conversationId)}/messages?${params}`,
      { headers: { Authorization: `Bearer ${auth.token}` } }
    );
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as {
      messages?: unknown;
      hasMore?: unknown;
      lastValue?: unknown;
    };
    if (!Array.isArray(body.messages)) {
      return null;
    }
    const parsed = itemsFromMessages(body.messages as RawMessage[], {
      agentName: options.agentName,
      beforeRank: options.beforeRank ?? null,
    });
    if (parsed === null) {
      return null;
    }
    // The server's lastValue is the oldest rank it returned; fall back to our
    // own minimum if it is ever missing, so paging cannot stall or repeat.
    const cursor =
      typeof body.lastValue === "number" ? body.lastValue : parsed.minRank;
    return {
      items: parsed.items,
      hasMore: body.hasMore === true && cursor !== null,
      cursor,
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort delete of a conversation through the private endpoint the web
 * app uses (the public API has none). Only used for the empty conversation an
 * attachment upload had to create, when nothing was ever sent into it.
 */
export async function deleteConversationPrivate(conversationId: string): Promise<boolean> {
  try {
    const auth = await privateAuth();
    if (!auth) {
      return false;
    }
    const res = await fetch(`${auth.base}/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Pure, for the smoke tests. Returns null for a shape it does not know (the
 * caller then falls back to the public load). Unknown message types are
 * skipped, never fatal; order is by rank, whatever order the page came in.
 */
export function itemsFromMessages(
  messages: RawMessage[],
  options: { agentName: string; beforeRank?: number | null }
): { items: TranscriptItem[]; minRank: number | null } | null {
  const { agentName, beforeRank } = options;
  // Edits and retries create new versions of a rank; show the latest only.
  const latest = new Map<number, RawMessage>();
  for (const m of messages) {
    if (typeof m !== "object" || m === null || typeof m.rank !== "number") {
      return null; // not the shape we know
    }
    // Page boundary: anything at or after the cursor is already on screen.
    if (beforeRank != null && m.rank >= beforeRank) {
      continue;
    }
    const seen = latest.get(m.rank);
    if (!seen || Number(m.version ?? 0) >= Number(seen.version ?? 0)) {
      latest.set(m.rank, m);
    }
  }

  const ranks = [...latest.keys()].sort((a, b) => a - b);
  const items: TranscriptItem[] = [];
  // Content fragments (attached files) precede the user message they belong
  // to; they are shown on it, as the live transcript does.
  let pendingFiles: string[] = [];
  for (const rank of ranks) {
    const m = latest.get(rank) as RawMessage;
    if (m.visibility === "deleted") {
      continue;
    }
    const content = typeof m.content === "string" ? m.content : "";
    if (m.type === "content_fragment") {
      if (typeof m.title === "string" && m.title) {
        pendingFiles.push(m.title);
      }
    } else if (m.type === "user_message") {
      items.push({
        kind: "user",
        id: newId(),
        text: content,
        ...(pendingFiles.length ? { attachments: pendingFiles } : {}),
      });
      pendingFiles = [];
    } else if (m.type === "agent_message") {
      if (!content.trim()) {
        continue; // a turn that produced nothing: no orphan header
      }
      items.push({
        kind: "agent-header",
        id: newId(),
        agentName:
          typeof m.configuration?.name === "string" ? m.configuration.name : agentName,
        detail: null,
      });
      items.push({ kind: "agent-text", id: newId(), text: content.trim(), streaming: false });
    } else if (m.type === "compaction_message") {
      // Only a compaction that landed changed what the agent sees.
      if (m.status === "failed") {
        continue;
      }
      items.push({
        kind: "note",
        id: newId(),
        tone: "info",
        text:
          m.status === "succeeded" || m.status === undefined
            ? "↻ Earlier messages were compacted into a summary here."
            : "↻ A compaction was still running here when this was loaded.",
      });
    }
  }
  return { items, minRank: ranks.length ? ranks[0] : null };
}
