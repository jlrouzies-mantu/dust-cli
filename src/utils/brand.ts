// Mantu brand palette (from mantu.com), approximated for terminal use.
// MANTU_PURPLE is intentionally brighter than the site's own button purple
// (#7C2AE8) - that shade reads as muddy/low-contrast in a terminal,
// especially against dark backgrounds.
export const MANTU_PURPLE = "#B366FF";
export const MANTU_GOLD = "#D4A72C";

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
