import { Text } from "ink";
import type { FC } from "react";
import React, { useEffect, useState } from "react";

// Plain ASCII only (no Unicode/braille spinner glyphs) so this renders
// correctly on consoles with limited font/glyph coverage, e.g. legacy
// Windows PowerShell 5 — same reasoning as the borderStyle="classic" and
// plain-ASCII footer text changes elsewhere in this fork.
const FRAMES = ["[ ]", "[o]", "[O]", "[o]"];
const INTERVAL_MS = 180;

export const ThinkingIcon: FC = () => {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % FRAMES.length);
    }, INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return <Text>{FRAMES[frame]}</Text>;
};
