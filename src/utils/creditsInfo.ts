import AuthService from "./authService.js";
import { getApiDomain } from "./dustClient.js";
import TokenStorage from "./tokenStorage.js";

async function fetchConsumedCredits(): Promise<number | null> {
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
    `${apiDomainRes.value}/api/w/${workspaceId}/credits/my-usage`,
    { headers: { Authorization: `Bearer ${accessTokenRes.value}` } }
  );
  if (!res.ok) {
    return null;
  }

  const data = (await res.json()) as {
    member?: { consumedAwuCredits?: unknown };
  };
  return typeof data.member?.consumedAwuCredits === "number"
    ? data.member.consumedAwuCredits
    : null;
}

/**
 * Fetches consumed workspace credits via the same undocumented endpoint
 * the Dust web dashboard itself calls (/api/w/{workspaceId}/credits/my-usage
 * — not the public /api/v1 API, no SDK support). It happens to accept the
 * same Bearer OAuth token the CLI already has, but Dust hasn't committed to
 * supporting this for external clients, so it could change or disappear
 * without notice.
 *
 * This is only fetched once per session (unlike context usage, which
 * refetches after every turn and so gets a natural retry for free), so a
 * single transient failure - e.g. the very first access token in a fresh
 * process not being refreshed yet - would otherwise blank this out for the
 * whole session. Retries a few times with backoff before giving up;
 * always returns null (never throws) so this can't affect the rest of the
 * app.
 */
export async function getConsumedCredits(): Promise<number | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await fetchConsumedCredits();
      if (result !== null) {
        return result;
      }
    } catch {
      // fall through to retry
    }
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  return null;
}
