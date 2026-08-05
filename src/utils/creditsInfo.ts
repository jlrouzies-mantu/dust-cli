import AuthService from "./authService.js";
import { getApiDomain } from "./dustClient.js";
import TokenStorage from "./tokenStorage.js";

/**
 * Fetches consumed workspace credits via the same undocumented endpoint
 * the Dust web dashboard itself calls (/api/w/{workspaceId}/credits/my-usage
 * — not the public /api/v1 API, no SDK support). It happens to accept the
 * same Bearer OAuth token the CLI already has, but Dust hasn't committed to
 * supporting this for external clients, so it could change or disappear
 * without notice. Always returns null on any failure rather than letting
 * this affect the rest of the app.
 */
export async function getConsumedCredits(): Promise<number | null> {
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
      `${apiDomainRes.value}/api/w/${workspaceId}/credits/my-usage`,
      { headers: { Authorization: `Bearer ${accessTokenRes.value}` } }
    );
    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as { consumedAwuCredits?: unknown };
    return typeof data.consumedAwuCredits === "number"
      ? data.consumedAwuCredits
      : null;
  } catch {
    return null;
  }
}
