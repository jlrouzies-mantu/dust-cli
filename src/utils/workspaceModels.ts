import AuthService from "./authService.js";
import { getApiDomain } from "./dustClient.js";
import type { ModelChoice, ProviderId } from "./modelSelection.js";
import { inferProviderId } from "./modelSelection.js";
import TokenStorage from "./tokenStorage.js";

/**
 * The models this workspace can actually use, from the endpoint the Dust web
 * app's own model picker calls.
 *
 * `GET /api/w/{wId}/models` returns every model the workspace is entitled to
 * with its `providerId`, `modelId`, `displayName` and - the reason this
 * exists - its real `contextSize`, plus a `degradedModelIds` list of ones
 * currently having problems.
 *
 * This replaces MODEL_CATALOG as `/model`'s source wherever it's reachable,
 * and the difference is not cosmetic: a hand-maintained list can't know what
 * a given workspace is entitled to, so it will happily offer models the
 * server then rejects. (Verified on a real workspace: a hand-written list
 * including `gpt-5.5`, `o3`, `deepseek-chat` and every xAI model offered
 * four things that workspace had no access to at all.) MODEL_CATALOG stays
 * as the offline fallback for when this call fails.
 *
 * Same standing and same caveat as contextUsage.ts and creditsInfo.ts: a
 * private endpoint, not `/api/v1`, no SDK support, works with the token this
 * CLI already has, and could change without notice. Every failure here
 * degrades to "use the built-in list" rather than erroring.
 */

export interface WorkspaceModels {
  models: ModelChoice[];
  degradedModelIds: Set<string>;
}

// Cached at module scope: a workspace's entitlements don't change mid-session,
// and the picker shouldn't pay for a round trip every time it opens.
let cached: WorkspaceModels | null = null;
let inFlight: Promise<WorkspaceModels | null> | null = null;

export function getCachedWorkspaceModels(): WorkspaceModels | null {
  return cached;
}

export async function getWorkspaceModels(): Promise<WorkspaceModels | null> {
  if (cached) {
    return cached;
  }
  // Deduped rather than fired per caller: the startup prefetch and a fast
  // `/model` can otherwise race into two identical requests.
  if (!inFlight) {
    inFlight = fetchWorkspaceModels().finally(() => {
      inFlight = null;
    });
  }
  const result = await inFlight;
  if (result) {
    cached = result;
  }
  return result;
}

interface RawModel {
  providerId?: unknown;
  modelId?: unknown;
  displayName?: unknown;
  contextSize?: unknown;
  shortDescription?: unknown;
  isLegacy?: unknown;
  isSelectable?: unknown;
}

async function fetchWorkspaceModels(): Promise<WorkspaceModels | null> {
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

    const res = await fetch(`${apiDomainRes.value}/api/w/${workspaceId}/models`, {
      headers: { Authorization: `Bearer ${accessTokenRes.value}` },
    });
    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as {
      models?: unknown;
      degradedModelIds?: unknown;
    };
    if (!Array.isArray(data.models)) {
      return null;
    }

    const degradedModelIds = new Set(
      Array.isArray(data.degradedModelIds)
        ? data.degradedModelIds.filter(
            (id): id is string => typeof id === "string"
          )
        : []
    );

    const models = data.models
      .map((raw) => toModelChoice(raw as RawModel))
      .filter((m): m is ModelChoice => m !== null);

    if (models.length === 0) {
      return null;
    }

    return { models, degradedModelIds };
  } catch {
    return null;
  }
}

function toModelChoice(raw: RawModel): ModelChoice | null {
  if (typeof raw.modelId !== "string" || raw.modelId.length === 0) {
    return null;
  }
  // A model the workspace can see but not choose (isSelectable false) would
  // be a dead entry in the picker.
  if (raw.isSelectable === false) {
    return null;
  }

  const providerId =
    typeof raw.providerId === "string"
      ? (raw.providerId as ProviderId)
      : inferProviderId(raw.modelId);
  if (!providerId) {
    return null;
  }

  const isAuto =
    providerId === "auto" ||
    providerId === "auto_complex" ||
    providerId === "auto_fast";

  return {
    modelId: raw.modelId,
    providerId,
    // The bare model id, not displayName: it's what /model accepts as an
    // argument and what the status bar shows, so the picker naming it
    // something else ("Claude Opus 5" vs claude-opus-5) would mean the
    // label you just picked isn't a thing you can type.
    label: shortLabel(raw.modelId),
    // Suppressed for the auto selectors even though the endpoint reports one:
    // it advertises the largest window in the pool, not what a given message
    // gets (this workspace's `auto` reports 1M while actually routing to a
    // 272k model), so showing it would be worse than showing nothing.
    contextSize:
      !isAuto && typeof raw.contextSize === "number" && raw.contextSize > 0
        ? raw.contextSize
        : undefined,
    note: raw.isLegacy === true ? "legacy" : undefined,
  };
}

// Fireworks ids are fully-qualified paths ("accounts/fireworks/models/kimi-k3")
// that would dominate the picker's label column; the last segment is what
// anyone actually calls them. resolveModel matches on substrings, so the
// short form still resolves to the full id.
function shortLabel(modelId: string): string {
  return modelId.startsWith("accounts/")
    ? (modelId.split("/").pop() ?? modelId)
    : modelId;
}
