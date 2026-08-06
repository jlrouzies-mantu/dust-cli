import AuthService from "./authService.js";
import { getApiDomain } from "./dustClient.js";
import TokenStorage from "./tokenStorage.js";

export interface ContextUsage {
  contextUsage: number;
  contextSize: number;
  modelId: string | null;
}

// Cached at module scope (outside any component's state), keyed by
// conversation ID since usage genuinely differs per conversation - same
// reasoning as creditsInfo.ts's cache. A transient failure on a refetch
// should never regress an already-shown value back to nothing.
const lastKnownUsageByConversation = new Map<string, ContextUsage>();

/**
 * Fetches per-conversation context-window usage via the same undocumented
 * endpoint the Dust web dashboard calls
 * (/api/w/{workspaceId}/assistant/conversations/{conversationId}/context-usage
 * — not the public /api/v1 API, no SDK support). Same caveat as
 * creditsInfo.ts: works with the CLI's existing Bearer token, but could
 * change or disappear without notice. Falls back to the last known-good
 * value for this conversation on any failure.
 */
export async function getContextUsage(
  conversationId: string
): Promise<ContextUsage | null> {
  const usage = await fetchContextUsage(conversationId);
  if (usage !== null) {
    lastKnownUsageByConversation.set(conversationId, usage);
    return usage;
  }
  return lastKnownUsageByConversation.get(conversationId) ?? null;
}

async function fetchContextUsage(
  conversationId: string
): Promise<ContextUsage | null> {
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
      `${apiDomainRes.value}/api/w/${workspaceId}/assistant/conversations/${conversationId}/context-usage`,
      { headers: { Authorization: `Bearer ${accessTokenRes.value}` } }
    );
    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as {
      contextUsage?: unknown;
      contextSize?: unknown;
      model?: { modelId?: unknown };
    };
    if (
      typeof data.contextUsage !== "number" ||
      typeof data.contextSize !== "number"
    ) {
      return null;
    }

    return {
      contextUsage: data.contextUsage,
      contextSize: data.contextSize,
      modelId:
        typeof data.model?.modelId === "string" ? data.model.modelId : null,
    };
  } catch {
    return null;
  }
}
