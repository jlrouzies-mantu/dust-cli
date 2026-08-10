import { MANTU_GOLD, MANTU_PURPLE } from "./brand.js";
import { lerpColor } from "./color.js";

/**
 * The pulsing brand glyph shared by every "working on it" indicator - the
 * in-app Thinking/tool status (ThinkingIcon) and the pre-Ink "Starting
 * dustm..." line in index.tsx.
 *
 * Lives here, dependency-free apart from the palette and colour maths,
 * precisely so index.tsx can animate it *before* the ink/react graph has
 * loaded - importing ThinkingIcon there would pull all of Ink in and defeat
 * the point of that early feedback line.
 */
export const PULSE_ICON = "♦";
export const PULSE_INTERVAL_MS = 120;

// A single steady glyph that breathes between the two brand colors (purple
// <-> gold), triangle-wave style, rather than a shape animation - closer to
// how Claude's own "✽" thinking indicator pulses in place.
const PULSE_STEPS = 12;
export const PULSE_COLOR_FRAMES: string[] = Array.from(
  { length: PULSE_STEPS },
  (_, i) => {
    const half = PULSE_STEPS / 2;
    const t = i < half ? i / half : (PULSE_STEPS - i) / half;
    return lerpColor(MANTU_PURPLE, MANTU_GOLD, t);
  }
);
