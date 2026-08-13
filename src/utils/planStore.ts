import { promises as fs } from "fs";
import { homedir } from "os";
import path from "path";

const PLANS_DIR = path.join(homedir(), ".dust-cli", "plans");

/**
 * Writes an approved plan to ~/.dust-cli/plans/<conversationId>-<n>.md.
 *
 * Same discipline as transcriptStore: this is a convenience, not part of the
 * flow, so a write failure must never interrupt the conversation - the plan
 * is already in the agent's context and in the terminal scrollback either
 * way. It exists so a plan can be reread, diffed or committed after the
 * session, which is most of the value of having written one down.
 *
 * Returns the path written, or null if it couldn't be.
 */
export async function saveApprovedPlan(
  conversationId: string | null,
  planMarkdown: string
): Promise<string | null> {
  try {
    await fs.mkdir(PLANS_DIR, { recursive: true });

    // Conversations can hold several approved plans (a long session, or a
    // rejected-then-revised one that is finally accepted), so the sequence
    // number comes from what is already on disk rather than a counter that
    // would reset when the CLI restarts.
    const prefix = `${conversationId ?? "no-conversation"}-`;
    let existing: string[] = [];
    try {
      existing = await fs.readdir(PLANS_DIR);
    } catch {
      // Directory was just created, or is unreadable; either way, start at 1.
    }
    const used = existing
      .filter((name) => name.startsWith(prefix) && name.endsWith(".md"))
      .map((name) => parseInt(name.slice(prefix.length, -3), 10))
      .filter((n) => Number.isFinite(n));
    const next = used.length > 0 ? Math.max(...used) + 1 : 1;

    const filePath = path.join(PLANS_DIR, `${prefix}${next}.md`);
    await fs.writeFile(filePath, `${planMarkdown.trimEnd()}\n`, "utf-8");
    return filePath;
  } catch {
    return null;
  }
}
