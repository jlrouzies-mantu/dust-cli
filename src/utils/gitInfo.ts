import { execSync } from "child_process";

/**
 * Returns the current git branch for `cwd`, or null if it's not a git
 * repository (or git isn't installed).
 */
export function getGitBranch(cwd: string): string | null {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return branch || null;
  } catch {
    return null;
  }
}
