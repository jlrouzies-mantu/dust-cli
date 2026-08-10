import { Text } from "ink";
import type { FC } from "react";
import React, { useEffect, useState } from "react";

import {
  PULSE_COLOR_FRAMES,
  PULSE_ICON,
  PULSE_INTERVAL_MS,
} from "../../utils/pulse.js";

export const ThinkingIcon: FC = () => {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % PULSE_COLOR_FRAMES.length);
    }, PULSE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return <Text color={PULSE_COLOR_FRAMES[frame]}>{PULSE_ICON}</Text>;
};
