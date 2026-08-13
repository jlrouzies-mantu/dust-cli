import { lerpColor } from "./color.js";

// Mantu brand palette (from mantu.com), approximated for terminal use.
// MANTU_PURPLE is intentionally brighter than the site's own button purple
// (#7C2AE8) - that shade reads as muddy/low-contrast in a terminal,
// especially against dark backgrounds.
export const MANTU_PURPLE = "#B366FF";
export const MANTU_GOLD = "#D4A72C";

// The Dust workspace (Mantu's tenant/organization) opens the status bar, so
// it gets the brand primary as the bar's identity anchor - a slot freed up
// by dropping the agent name, which the input box's own "@agent" prefix
// already shows. Left non-bold so it stays an anchor rather than a shout.
export const STATUS_BAR_WORKSPACE = MANTU_PURPLE;

// Context usage is the one status-bar field whose *value* matters, so it's
// coloured as a gauge rather than given a fixed accent: invisible-ish while
// there's nothing to worry about, escalating as the window fills. All four
// steps are mantu.com's own tokens (grey-400, yellow-500, their orange,
// red-main), which also keeps a blue out of a palette that doesn't have one.
const CONTEXT_GAUGE_STEPS: { threshold: number; color: string }[] = [
  { threshold: 90, color: "#EE2737" }, // red-main - about to run out
  { threshold: 75, color: "#FF7F00" }, // orange - getting tight
  { threshold: 50, color: "#EFB003" }, // yellow-500 - past halfway
  { threshold: 0, color: "#8F90A1" }, // grey-400 - nothing to see yet
];

/**
 * Gauge colour for a context-window fill percentage (0-100).
 */
export function contextUsageColor(percentUsed: number): string {
  const step = CONTEXT_GAUGE_STEPS.find((s) => percentUsed >= s.threshold);
  // The 0-threshold entry always matches, but satisfy the type anyway.
  return step?.color ?? "#8F90A1";
}

// Credits are a budget drawn down gradually, not a pressure gauge that's
// fine until it suddenly isn't - so they fade *continuously* from lilac to a
// red-lilac rather than stepping through the discrete alarm colours context
// uses. That difference in behaviour is deliberate: it's one of the things
// distinguishing the two meters at a glance, alongside the dot ramp vs the
// block ramp.
const CREDITS_EMPTY_COLOR = "#CD9BF1"; // lilac - a mantu.com accent
const CREDITS_FULL_COLOR = "#E0457F"; // red-lilac

/**
 * Ramp colour for a credits-consumed percentage (0-100).
 */
export function creditsUsageColor(percentUsed: number): string {
  const t = Math.max(0, Math.min(100, percentUsed)) / 100;
  return lerpColor(CREDITS_EMPTY_COLOR, CREDITS_FULL_COLOR, t);
}

// Muted mint-green for the git branch in the status bar - a toned-down take
// on mantu.com's own #ABEDD3 mint (that pastel is a light-surface
// background there, so it washes out as text on a dark terminal).
//
// Deliberately not purple: the bar already spends purple on the agent name
// and the context-usage figure, so a third purple made the branch read as
// part of those rather than its own field. Green also matches the
// convention most git tooling and shell prompts use for a branch name, and
// being cool-toned it separates cleanly from the warm gold path sitting
// immediately to its left.
export const STATUS_BAR_BRANCH = "#8FC9B0";

// Bright gold-yellow for the "report bug" hint line - shifted further toward
// yellow than MANTU_GOLD (which is reserved for the logo/branding elsewhere
// in the header) so it reads as less orange, and brighter so it stands out
// in the header. Deliberately stops short of a pure/neon yellow like
// #FFFF00, which reads as a warning rather than a hint and clashes with the
// warm gold branding right next to it.
export const BUG_REPORT_YELLOW = "#F5DC4E";

// Companions to MANTU_PURPLE/MANTU_GOLD for the chat transcript's speaker
// names - same palette family, but distinct shades so the transcript
// doesn't just repeat the exact accent colors already used everywhere else
// (status bar, header). Warm yellow-orange for the user, violet-pink for
// the agent.
export const MANTU_USER_ACCENT = "#E8A548";
export const MANTU_AGENT_ACCENT = "#CC7DE0";

// Muted pink for the "Thinking…" status line - dimmer than
// MANTU_AGENT_ACCENT so it doesn't compete with it.
export const MANTU_THINKING_PINK = "#C97B94";

// Dark gray instead of pure black - a solid black fill is indistinguishable
// from a terminal's own black background (e.g. default PowerShell 7), so
// code blocks need a shade that actually reads as "a different surface".
export const CODE_BLOCK_BG = "#121212";

// Neutral gray for status-bar figures that should read as plain information
// rather than another colored accent. This is mantu.com's own `--grey-300`
// token: light enough to sit above the dim-rendered hint line below the
// input, but well short of white, which sits brighter than most terminal
// foregrounds and would draw more attention than the brand colors next to
// it. Its faint blue tint also keeps it from muddying into the warm gold
// path/credits text nearby.
export const STATUS_BAR_TEXT = "#B7B8C2";

// Filled-block styling for the queued / steered / looping message boxes
// under the input: a title bar fading into a darker shade of the same hue
// for the message rows. Warm gold marks "waiting", purple marks
// "interrupting", blue marks "repeating on a timer".
//
// Both blocks deliberately stay *dark* - light text on a dark tinted
// background, rather than dark text on a saturated brand-color bar. A
// full-width band of MANTU_GOLD/MANTU_PURPLE reads as an alert and pulls
// focus away from the conversation, which is the wrong emphasis for a
// pending-messages hint sitting under the input. Keeping the hue only in
// the text preserves the gold-vs-purple distinction at a glance while
// letting the blocks recede. The title row is a step lighter than the body
// so it still reads as a header.
export const QUEUED_TITLE_BG = "#3A2E0A";
export const QUEUED_TITLE_FG = "#E8C96A";
export const QUEUED_BODY_BG = "#241D06";
export const QUEUED_BODY_FG = "#B9A263";

export const STEERED_TITLE_BG = "#2B1247";
export const STEERED_TITLE_FG = "#C9A6F0";
export const STEERED_BODY_BG = "#1B0B2E";
export const STEERED_BODY_FG = "#9C82C0";

// Permission-mode colours for the status bar segment (see utils/chatMode.ts).
// Deliberately a set of their own rather than reusing the queued/steered/loop
// hues: those mark *pending work*, while this marks a standing permission
// level, and a shared colour would imply a relationship that isn't there.
//
// Grey recedes for the default. Amber is the warning tone for "edits land
// without asking". Teal is unused anywhere else in the UI, so plan mode reads
// as its own distinct state rather than borrowing gold's "waiting" or blue's
// "looping" connotation.
export const MODE_NORMAL_FG = "#8A8A8A";
export const MODE_AUTO_FG = "#E8A548";
export const MODE_PLAN_FG = "#4FD1C5";

// Blue, for the /loop block. Unlike the other two this one is persistent -
// it stays up for as long as a loop is armed, not just while something is
// pending - so it's pitched a touch darker than the steered pair to sit
// quietly under the input rather than nag. Blue also keeps it clearly
// distinct from gold "waiting" and purple "interrupting" on the same screen,
// which can all three be visible at once.
export const LOOP_TITLE_BG = "#0E2947";
export const LOOP_TITLE_FG = "#9CC6F0";
export const LOOP_BODY_BG = "#081A2E";
export const LOOP_BODY_FG = "#7A9EC0";
