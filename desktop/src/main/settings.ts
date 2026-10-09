import { app } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Small, non-secret preferences. Tokens never live here: they stay in the
 * keychain via the CLI's TokenStorage.
 */
export interface Settings {
  workingDir?: string;
  agentId?: string;
  windowBounds?: { width: number; height: number; x?: number; y?: number };
}

function file(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

let cache: Settings | null = null;

export async function loadSettings(): Promise<Settings> {
  if (cache) {
    return cache;
  }
  try {
    cache = JSON.parse(await fs.readFile(file(), "utf-8")) as Settings;
  } catch {
    cache = {};
  }
  return cache;
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  cache = { ...(await loadSettings()), ...patch };
  try {
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.writeFile(file(), JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // Preferences are a convenience; never let a write failure surface.
  }
}
