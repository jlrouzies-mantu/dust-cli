import { MANTU_GOLD, MANTU_PURPLE } from "../../../src/utils/brand";
import { lerpColor } from "../../../src/utils/color";

// Ink's dimColor is the terminal's "faint" attribute: about half intensity.
const GROUND = "#161616";
const dim = (hex: string) => lerpColor(hex, GROUND, 0.5);

// [text, dim, hue] runs per row, exactly as Conversation.tsx's welcome header
// prints them (and as scripts/gen-icons.mjs draws the app icon).
const ROWS: [string, boolean, "p" | "g"][][] = [
  [["█", true, "p"], ["▀▄ ", false, "p"], ["█ █", true, "p"]],
  [["█", true, "p"], ["▄▀ ", false, "p"], ["█▄█", false, "p"]],
  [["█▀▀ ", true, "g"], ["▀█▀", true, "g"]],
  [["▄██ ", false, "g"], [" █ ", true, "g"]],
];

export function Logo({ className = "" }: { className?: string }) {
  return (
    <pre className={`logo ${className}`} aria-hidden="true">
      {ROWS.map((runs, r) => (
        <div key={r}>
          {runs.map(([text, isDim, hue], i) => {
            const base = hue === "p" ? MANTU_PURPLE : MANTU_GOLD;
            return (
              <span key={i} style={{ color: isDim ? dim(base) : base }}>
                {text}
              </span>
            );
          })}
        </div>
      ))}
    </pre>
  );
}
