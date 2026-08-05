/**
 * This fork is not published to npm, so there is no registry to check
 * against. Always report no update available.
 */
export async function checkForUpdates(): Promise<{
  currentVersion: string;
  latestVersion: string;
} | null> {
  return null;
}
