import { Text } from "ink";
import type { FC } from "react";
import React, { useEffect, useState } from "react";

import { MANTU_GOLD, MANTU_PURPLE } from "../../utils/brand.js";

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (c: number) => Math.max(0, Math.min(255, Math.round(c)));
  return `#${[r, g, b]
    .map((c) => clamp(c).toString(16).padStart(2, "0"))
    .join("")}`;
}

function lerpColor(from: string, to: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(from);
  const [r2, g2, b2] = hexToRgb(to);
  return rgbToHex(
    r1 + (r2 - r1) * t,
    g1 + (g2 - g1) * t,
    b1 + (b2 - b1) * t
  );
}

// A single steady glyph that breathes between the two brand colors (purple
// <-> gold), triangle-wave style, rather than a shape animation - closer to
// how Claude's own "✽" thinking indicator pulses in place.
const ICON = "♦";
const STEPS = 12;
const INTERVAL_MS = 120;
const COLOR_FRAMES: string[] = Array.from({ length: STEPS }, (_, i) => {
  const half = STEPS / 2;
  const t = i < half ? i / half : (STEPS - i) / half;
  return lerpColor(MANTU_PURPLE, MANTU_GOLD, t);
});

export const ThinkingIcon: FC = () => {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % COLOR_FRAMES.length);
    }, INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return <Text color={COLOR_FRAMES[frame]}>{ICON}</Text>;
};
