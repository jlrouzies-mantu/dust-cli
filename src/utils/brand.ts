// Mantu brand palette (from mantu.com), approximated for terminal use.
// MANTU_PURPLE is intentionally brighter than the site's own button purple
// (#7C2AE8) - that shade reads as muddy/low-contrast in a terminal,
// especially against dark backgrounds.
export const MANTU_PURPLE = "#B366FF";
export const MANTU_GOLD = "#D4A72C";

// Bright gold-yellow for the "report bug" hint line - shifted a bit further
// toward yellow than MANTU_GOLD (which is reserved for the logo/branding
// elsewhere in the header) so it reads as less orange, while staying bright.
export const BUG_REPORT_YELLOW = "#E8C930";

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

// Filled-block styling for the queued / steered message boxes under the
// input. Each block is a brand-colored title bar fading into a dark tint of
// the same hue for the message rows.
//
// The title bars deliberately use *dark* text on the brand color rather
// than white: MANTU_GOLD and MANTU_PURPLE are both light enough that white
// on them lands around 2:1 contrast, which is unreadable at terminal font
// sizes. #1A0B2E (the same near-black the README badges use as their label
// color) gives roughly 8-9:1 instead. The body rows invert that - dark
// background, light tinted text - which is what produces the fade.
export const QUEUED_TITLE_BG = MANTU_GOLD;
export const QUEUED_TITLE_FG = "#1A0B2E";
export const QUEUED_BODY_BG = "#3A2E0A";
export const QUEUED_BODY_FG = "#F3E3B3";

export const STEERED_TITLE_BG = MANTU_PURPLE;
export const STEERED_TITLE_FG = "#1A0B2E";
export const STEERED_BODY_BG = "#2B1247";
export const STEERED_BODY_FG = "#E7D5FF";
