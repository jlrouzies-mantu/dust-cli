import AuthService from "./authService.js";
import { getApiDomain } from "./dustClient.js";
import TokenStorage from "./tokenStorage.js";

export interface ContextUsage {
  contextUsage: number;
  contextSize: number;
  modelId: string | null;
}

/**
 * Fetches per-conversation context-window usage via the same undocumented
 * endpoint the Dust web dashboard calls
 * (/api/w/{workspaceId}/assistant/conversations/{conversationId}/context-usage
 * — not the public /api/v1 API, no SDK support). Same caveat as
 * creditsInfo.ts: works with the CLI's existing Bearer token, but could
 * change or disappear without notice. Always returns null on any failure.
 */
export async function getContextUsage(
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
