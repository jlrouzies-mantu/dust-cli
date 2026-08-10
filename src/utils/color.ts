/**
 * Small, dependency-free colour helpers.
 *
 * Kept free of imports on purpose: index.tsx uses these to paint its
 * "Starting dustm..." line *before* the ink/react graph loads, so anything
 * pulled in here would delay that early feedback.
 */

export function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (c: number) => Math.max(0, Math.min(255, Math.round(c)));
  return `#${[r, g, b]
    .map((c) => clamp(c).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Linearly interpolates between two `#rrggbb` colours; `t` is 0..1. */
export function lerpColor(from: string, to: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(from);
  const [r2, g2, b2] = hexToRgb(to);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

/** Truecolor SGR foreground escape for a `#rrggbb` string. */
export function ansiForegroundFor(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export const ANSI_RESET = "\x1b[0m";
