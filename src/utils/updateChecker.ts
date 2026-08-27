import { CLI_VERSION } from "./version.js";

// This fork isn't published to npm - its releases live on GitHub instead
// (see scripts/Install-DustCLI.ps1 and scripts/install-dustcli.sh, which
// pull the exact same "latest" release this checks against).
const RELEASES_API_URL =
  "https://api.github.com/repos/jlrouzies-mantu/dust-cli/releases/latest";

const CHECK_TIMEOUT_MS = 3_000;

function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewer(latest: string, current: string): boolean {
  const latestParts = parseVersion(latest);
  const currentParts = parseVersion(current);
  if (!latestParts || !currentParts) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    if (latestParts[i] !== currentParts[i]) {
      return latestParts[i] > currentParts[i];
    }
  }
  return false;
}

/**
 * Checks this fork's own GitHub releases for a version newer than the one
 * currently running. Never throws - a network hiccup, a corporate proxy
 * blocking api.github.com (the same caveat the install scripts already
 * document), or a malformed response all just mean "no update available"
 * rather than breaking startup.
 */
export async function checkForUpdates(): Promise<{
  currentVersion: string;
  latestVersion: string;
} | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const res = await fetch(RELEASES_API_URL, {
      signal: controller.signal,
      headers: { "User-Agent": "dustm-cli/update-check" },
    });
    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as { tag_name?: unknown };
    if (typeof data.tag_name !== "string") {
      return null;
    }

    const latestVersion = data.tag_name.replace(/^v/, "");
    if (!isNewer(latestVersion, CLI_VERSION)) {
      return null;
    }

    return { currentVersion: CLI_VERSION, latestVersion };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
