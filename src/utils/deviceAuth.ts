import type { Result, WorkspaceType } from "@dust-tt/client";
import { Err, Ok } from "@dust-tt/client";
import { jwtDecode } from "jwt-decode";
import fetch from "node-fetch";

import { getDustClient, resetDustClient } from "./dustClient.js";
import { normalizeError } from "./errors.js";
import TokenStorage from "./tokenStorage.js";

/**
 * UI-free WorkOS OAuth device-code flow, for front ends that are not the Ink
 * CLI (the desktop app).
 *
 * NOTE: this deliberately duplicates the logic in src/ui/commands/Auth.tsx
 * and src/ui/components/WorkspaceSelector.tsx, which were left untouched so
 * the CLI's behaviour stays identical. Keep the two in step (same endpoints,
 * same scope, same region-claim handling, same storage calls) until Auth.tsx
 * is switched over to this module.
 *
 * Tokens, region and workspace are written through TokenStorage, i.e. the
 * same keychain entries the CLI uses, so signing in via either signs in both.
 */

const SCOPE = "openid profile email";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

interface TokenErrorResponse {
  error: string;
  error_description?: string;
}

interface DecodedAccessToken {
  exp: number;
  [key: string]: unknown;
}

/** What a front end may show. Never contains the private device code. */
export interface DeviceAuthPublicInfo {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface DeviceAuthSession {
  info: DeviceAuthPublicInfo;
  // Kept off DeviceAuthPublicInfo on purpose: it is the secret half of the
  // flow and must not cross into a renderer.
  deviceCode: string;
  intervalSec: number;
}

export type DeviceAuthProgress =
  | { kind: "waiting"; attempt: number }
  | { kind: "slow_down" }
  | { kind: "saving" };

function workOS(): { domain: string; clientId: string } {
  return {
    domain: process.env.WORKOS_DOMAIN || "",
    clientId: process.env.WORKOS_CLIENT_ID || "",
  };
}

/**
 * Asks WorkOS for a device code. Does not open a browser and does not touch
 * stored tokens (the CLI's `--force` clears them first; callers that want that
 * call TokenStorage.clearTokens themselves).
 */
export async function startDeviceAuth(): Promise<
  Result<DeviceAuthSession, Error>
> {
  const { domain, clientId } = workOS();
  try {
    const response = await fetch(
      `https://${domain}/user_management/authorize/device`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, scope: SCOPE }),
      }
    );
    if (!response.ok) {
      const text = await response.text();
      return new Err(
        new Error(text || `Device authorization failed (${response.status})`)
      );
    }
    const data = (await response.json()) as DeviceCodeResponse;
    return new Ok({
      deviceCode: data.device_code,
      intervalSec: data.interval,
      info: {
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        verificationUriComplete: data.verification_uri_complete,
        expiresAt: Date.now() + data.expires_in * 1000,
      },
    });
  } catch (error) {
    return new Err(normalizeError(error));
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/**
 * Polls until the user authorizes, the code expires, an error occurs, or
 * `signal` aborts. On success the tokens and region are saved (exactly as
 * Auth.tsx does) and the cached API client is reset. Workspace selection is a
 * separate step: see listWorkspaces / selectWorkspace.
 */
export async function pollDeviceAuth(
  session: DeviceAuthSession,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: DeviceAuthProgress) => void;
  } = {}
): Promise<Result<void, Error>> {
  const { signal, onProgress } = options;
  const { domain, clientId } = workOS();
  let interval = session.intervalSec;
  let attempt = 0;

  for (;;) {
    await sleep(interval * 1000, signal);
    if (signal?.aborted) {
      return new Err(new Error("Sign-in cancelled."));
    }
    if (Date.now() >= session.info.expiresAt) {
      return new Err(new Error("Authentication timed out. Please try again."));
    }

    attempt++;
    onProgress?.({ kind: "waiting", attempt });

    let data: TokenResponse | TokenErrorResponse;
    try {
      const response = await fetch(
        `https://${domain}/user_management/authenticate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: DEVICE_GRANT,
            device_code: session.deviceCode,
            client_id: clientId,
          }),
          signal: signal as never,
        }
      );
      data = (await response.json()) as TokenResponse | TokenErrorResponse;
    } catch (error) {
      if (signal?.aborted) {
        return new Err(new Error("Sign-in cancelled."));
      }
      return new Err(normalizeError(error));
    }

    if ("error" in data) {
      if (data.error === "authorization_pending") {
        continue;
      }
      if (data.error === "slow_down") {
        interval += 5;
        onProgress?.({ kind: "slow_down" });
        continue;
      }
      return new Err(
        new Error(
          `Authentication error: ${data.error_description || data.error}`
        )
      );
    }

    onProgress?.({ kind: "saving" });
    try {
      await TokenStorage.saveTokens(data.access_token, data.refresh_token);
      await saveRegionFromToken(data.access_token);
      resetDustClient();
      return new Ok(undefined);
    } catch (error) {
      return new Err(normalizeError(error));
    }
  }
}

async function saveRegionFromToken(accessToken: string): Promise<void> {
  try {
    const decoded = jwtDecode<DecodedAccessToken>(accessToken);
    const claimNamespace = process.env.WORKOS_CLAIM_NAMESPACE || "";
    const region = decoded[`${claimNamespace}region`];
    // Same fallback as Auth.tsx: an absent claim defaults to us-central1.
    await TokenStorage.saveRegion(
      typeof region === "string" && region ? region : "us-central1"
    );
  } catch {
    await TokenStorage.saveRegion("us-central1");
  }
}

/** The workspaces the signed-in user can pick from (WorkspaceSelector.tsx). */
export async function listWorkspaces(): Promise<
  Result<WorkspaceType[], Error>
> {
  const clientRes = await getDustClient();
  if (clientRes.isErr()) {
    return new Err(clientRes.error);
  }
  const client = clientRes.value;
  if (!client) {
    return new Err(new Error("Not signed in."));
  }
  const me = await client.me();
  if (me.isErr()) {
    return new Err(new Error(`Error fetching workspaces: ${me.error.message}`));
  }
  const workspaces = me.value.workspaces || [];
  if (workspaces.length === 0) {
    return new Err(
      new Error(
        "You don't have any workspaces. Visit https://dust.tt to create a workspace."
      )
    );
  }
  return new Ok(workspaces);
}

export async function selectWorkspace(workspaceId: string): Promise<void> {
  await TokenStorage.saveWorkspaceId(workspaceId);
  // The cached client captured the previous workspace id.
  resetDustClient();
}
