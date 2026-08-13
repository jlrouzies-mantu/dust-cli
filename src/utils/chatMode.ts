/**
 * The chat's permission mode, cycled with Shift+Tab (mirroring Claude Code).
 *
 * Modelled as one tri-state rather than two independent booleans because the
 * two non-default modes contradict each other: plan mode blocks every writing
 * tool outright, so "automatically approve edits" has nothing left to approve.
 * Holding them as separate flags would let both be on at once and force every
 * reader to decide which wins.
 */
import { MODE_AUTO_FG, MODE_NORMAL_FG, MODE_PLAN_FG } from "./brand.js";

export type ChatMode = "normal" | "auto" | "plan";

// Cycle order matches Claude Code's: normal -> auto-accept -> plan -> normal.
const CYCLE: ChatMode[] = ["normal", "auto", "plan"];

export function nextChatMode(current: ChatMode): ChatMode {
  const index = CYCLE.indexOf(current);
  // A value not in the cycle (only reachable via a bad cast) restarts it
  // rather than getting stuck.
  return CYCLE[(index + 1) % CYCLE.length] ?? "normal";
}

export function isAutoAcceptMode(mode: ChatMode): boolean {
  return mode === "auto";
}

export function isPlanMode(mode: ChatMode): boolean {
  return mode === "plan";
}

/**
 * The mode's status-bar label. Always present, including in normal mode: an
 * absent indicator is ambiguous (is nothing engaged, or is the indicator just
 * off-screen?), and the whole point of putting it in the status bar is that
 * the current permission level should never have to be inferred.
 *
 * The glyph set is a deliberate progression of how much the agent may do on
 * its own - hollow, forward, solid - rather than a borrowed pause/play
 * metaphor: □ nothing engaged, »» running ahead, ■ sealed shut. All three are
 * in the same family the rest of this UI already renders (◊ ↻ ➤ ✓), so they
 * hold up on the legacy Windows consoles this fork targets.
 */
export function chatModeLabel(mode: ChatMode): string {
  switch (mode) {
    case "auto":
      return "»» auto-edit";
    case "plan":
      return "■ plan";
    case "normal":
      return "□ normal";
  }
}

// Colour per mode, from the palette in brand.ts - see there for why these are
// their own colours rather than reused from the queued/steered/loop blocks.
export function chatModeColor(mode: ChatMode): string {
  switch (mode) {
    case "auto":
      return MODE_AUTO_FG;
    case "plan":
      return MODE_PLAN_FG;
    case "normal":
      return MODE_NORMAL_FG;
  }
}

// Longer form, for the `/help` listing. Not used for per-change feedback:
// changing mode deliberately writes nothing to the conversation, since the
// status bar carries it permanently (see applyChatMode in Chat.tsx).
export function describeChatMode(mode: ChatMode): string {
  switch (mode) {
    case "auto":
      return "auto-edit - file edits apply without prompting";
    case "plan":
      return "plan - research only, no edits or commands until you approve a plan";
    case "normal":
      return "normal - you approve each file edit";
  }
}
