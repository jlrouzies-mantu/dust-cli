import { clipboard, shell } from "electron";

import AuthService from "../../../src/utils/authService";
import type { DeviceAuthSession } from "../../../src/utils/deviceAuth";
import {
  listWorkspaces,
  pollDeviceAuth,
  selectWorkspace,
  startDeviceAuth,
} from "../../../src/utils/deviceAuth";
import { resetDustClient } from "../../../src/utils/dustClient";
import { normalizeError } from "../../../src/utils/errors";
import TokenStorage from "../../../src/utils/tokenStorage";
import type { AuthStatus, Result } from "../shared/ipc";
import { emit } from "./bus";

/**
 * Sign-in for the desktop app: the CLI's WorkOS device-code flow
 * (src/utils/deviceAuth.ts), driven natively, no terminal in the loop.
 *
 * Everything lands in TokenStorage, the same keychain entries the CLI reads,
 * so signing in here signs the CLI in and vice versa. The renderer only ever
 * learns the user code and the verification URL.
 */

let status: AuthStatus = { kind: "checking" };
let session: DeviceAuthSession | null = null;
let abort: AbortController | null = null;
let onReady: (() => void) | null = null;

let onSignedOut: (() => Promise<void>) | null = null;

export function setReadyHandler(handler: () => void): void {
  onReady = handler;
}

/**
 * Runs before a sign-out clears the tokens (so a running turn can still be
 * cancelled server-side) and when a session is found expired: stops the turn,
 * the loop and the fs MCP server registered under the old identity.
 */
export function setSignedOutHandler(handler: () => Promise<void>): void {
  onSignedOut = handler;
}

export function getAuthStatus(): AuthStatus {
  return status;
}

function setStatus(next: AuthStatus): void {
  status = next;
  emit({ type: "auth", status });
}

/**
 * Decides where the user stands: signed in (and workspace chosen), needing a
 * workspace, or signed out. Refreshes the access token if it can.
 */
export async function checkAuth(): Promise<AuthStatus> {
  try {
    const authed = await AuthService.isAuthenticated();
    if (!authed) {
      setStatus({ kind: "signed-out" });
      return status;
    }
    const apiKey = (await TokenStorage.getAccessToken())?.startsWith("sk-");
    const workspaceId = await TokenStorage.getWorkspaceId();
    if (workspaceId || apiKey) {
      setStatus({ kind: "ready" });
      onReady?.();
      return status;
    }
    await offerWorkspaces();
  } catch (error) {
    // keytar failing to load or the keychain being locked lands here.
    setStatus({
      kind: "error",
      message: `Could not read stored credentials: ${normalizeError(error).message}`,
    });
  }
  return status;
}

async function offerWorkspaces(): Promise<void> {
  const res = await listWorkspaces();
  if (res.isErr()) {
    setStatus({ kind: "error", message: res.error.message });
    return;
  }
  const workspaces = res.value;
  if (workspaces.length === 1) {
    await completeWorkspace(workspaces[0].sId);
    return;
  }
  setStatus({
    kind: "choose-workspace",
    workspaces: workspaces.map((w) => ({
      sId: w.sId,
      name: w.name,
      role: w.role,
    })),
  });
}

async function completeWorkspace(id: string): Promise<void> {
  await selectWorkspace(id);
  setStatus({ kind: "ready" });
  onReady?.();
}

export async function selectWorkspaceId(id: string): Promise<Result> {
  if (status.kind !== "choose-workspace") {
    return { ok: false, error: "No workspace choice is pending." };
  }
  if (!status.workspaces.some((w) => w.sId === id)) {
    return { ok: false, error: "Unknown workspace." };
  }
  try {
    await completeWorkspace(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: normalizeError(error).message };
  }
}

export async function startSignIn(): Promise<Result> {
  if (status.kind === "signing-in") {
    return { ok: true };
  }
  const started = await startDeviceAuth();
  if (started.isErr()) {
    setStatus({ kind: "error", message: started.error.message });
    return { ok: false, error: started.error.message };
  }
  session = started.value;
  abort = new AbortController();
  const { info } = session;
  const publish = (phase: "waiting" | "slow" | "saving") =>
    setStatus({
      kind: "signing-in",
      userCode: info.userCode,
      verificationUri: info.verificationUri,
      expiresAt: info.expiresAt,
      phase,
    });
  publish("waiting");

  // Open the browser straight away, like `dustm login` does.
  void openBrowser();

  const mine = session;
  void pollDeviceAuth(mine, {
    signal: abort.signal,
    onProgress: (p) => {
      if (session !== mine) {
        return;
      }
      publish(
        p.kind === "saving" ? "saving" : p.kind === "slow_down" ? "slow" : "waiting"
      );
    },
  }).then(async (res) => {
    if (session !== mine) {
      return; // cancelled or superseded
    }
    session = null;
    abort = null;
    if (res.isErr()) {
      setStatus({ kind: "signed-out", reason: res.error.message });
      return;
    }
    await checkAuth();
  });

  return { ok: true };
}

export function cancelSignIn(): Result {
  abort?.abort();
  abort = null;
  session = null;
  if (status.kind === "signing-in") {
    setStatus({ kind: "signed-out" });
  }
  return { ok: true };
}

/** Opens the verification page. https only, and only the URL main holds. */
export async function openBrowser(): Promise<Result> {
  if (!session) {
    return { ok: false, error: "No sign-in in progress." };
  }
  const result = await openHttps(session.info.verificationUriComplete);
  return result.ok
    ? result
    : openHttps(session.info.verificationUri);
}

export async function openHttps(url: string): Promise<Result> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Invalid URL." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Only https links can be opened." };
  }
  await shell.openExternal(parsed.toString());
  return { ok: true };
}

export function copyCode(): Result {
  if (!session) {
    return { ok: false, error: "No sign-in in progress." };
  }
  clipboard.writeText(session.info.userCode);
  return { ok: true };
}

/** Called when a request fails because the stored session is no longer good. */
export async function sessionExpired(reason: string): Promise<void> {
  resetDustClient();
  const authed = await AuthService.isAuthenticated().catch(() => false);
  if (!authed) {
    await onSignedOut?.().catch(() => undefined);
    setStatus({ kind: "signed-out", reason });
  }
}

export async function signOut(): Promise<Result> {
  cancelSignIn();
  try {
    await onSignedOut?.().catch(() => undefined);
    await AuthService.logout();
    setStatus({ kind: "signed-out" });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: normalizeError(error).message };
  }
}
