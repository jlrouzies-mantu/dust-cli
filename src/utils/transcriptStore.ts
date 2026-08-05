import { promises as fs } from "fs";
import { homedir } from "os";
import path from "path";

const TRANSCRIPTS_DIR = path.join(homedir(), ".dust-cli", "transcripts");

export interface TranscriptEntry {
  role: "user" | "agent";
  text: string;
  messageId?: string;
  timestamp: string;
}

function transcriptFilePath(conversationId: string): string {
  return path.join(TRANSCRIPTS_DIR, `${conversationId}.jsonl`);
}

/**
 * Appends one turn to the local, crash-safe transcript for a conversation
 * (~/.dust-cli/transcripts/<conversationId>.jsonl, one JSON object per
 * line). This is a durability backstop only: the server's own conversation
 * history is always the source of truth on resume (the app re-fetches it
 * via getConversation), so no merge/reconciliation is needed here. The
 * file exists so a crash mid-turn still leaves the user's side of the
 * exchange recorded locally, and so past conversations can be inspected
 * offline.
 */
export async function appendTranscriptEntry(
  conversationId: string,
  entry: Omit<TranscriptEntry, "timestamp">
): Promise<void> {
  try {
    await fs.mkdir(TRANSCRIPTS_DIR, { recursive: true });
    const line = JSON.stringify({
      ...entry,
      timestamp: new Date().toISOString(),
    });
    await fs.appendFile(
      transcriptFilePath(conversationId),
      line + "\n",
      "utf-8"
    );
  } catch {
    // Local persistence is a best-effort safety net; never let a write
    // failure here interrupt the actual conversation.
  }
}

