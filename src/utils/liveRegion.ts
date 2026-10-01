/**
 * Height budgets for Ink's live region - everything rendered outside
 * <Static> (streaming preview, spinner, queue blocks, pickers, input box,
 * status bar).
 *
 * Why this exists: Ink 5 keeps every line ever printed through <Static> in
 * memory (`fullStaticOutput` in node_modules/ink/build/ink.js), and the
 * moment the live region's height reaches `stdout.rows` its onRender stops
 * updating incrementally and instead writes
 * `clearTerminal + fullStaticOutput + liveOutput` on *every* frame. Every
 * keystroke, every spinner tick and every streaming update then re-sends the
 * whole conversation to the terminal, so the cost of a single frame grows
 * with the length of the session - which is exactly how a long chat came to
 * feel progressively more sluggish to type into.
 *
 * Nothing in Ink exposes a way to opt out of that, so the only fix that
 * holds is to keep the live region strictly shorter than the terminal. Every
 * part of it that can grow with content is bounded here, relative to the
 * terminal's actual height, rather than by a fixed line count that is fine
 * on a tall window and overflows on a short one (or a split pane).
 *
 * Pure and free of Ink/React imports so the arithmetic can be unit-tested.
 */

// Rows the live region needs for everything that isn't budgeted below: the
// spinner line, the input box's borders, the shortcut hint, the rule, a
// wrapped status bar, and a little slack for retry/compaction/btw status
// lines. Deliberately generous - undershooting this is what lands back on
// Ink's full-repaint path, overshooting only shows a little less preview.
const LIVE_REGION_CHROME_ROWS = 16;

const DEFAULT_ROWS = 24;
const DEFAULT_COLUMNS = 80;

function rowsOrDefault(rows: number | undefined): number {
  return rows && rows > 0 ? rows : DEFAULT_ROWS;
}

/** Visible rows for the streaming answer / reasoning preview. */
export function streamingPreviewRowBudget(rows: number | undefined): number {
  return Math.max(2, Math.min(6, rowsOrDefault(rows) - LIVE_REGION_CHROME_ROWS));
}

/**
 * Visible entries for a picker (the `/` command list). `preferred` is what
 * the picker would show on a tall terminal.
 */
export function selectorRowBudget(
  rows: number | undefined,
  preferred: number
): number {
  return Math.max(
    3,
    Math.min(preferred, rowsOrDefault(rows) - LIVE_REGION_CHROME_ROWS)
  );
}

/** Visible lines of the draft in the input box. */
export function inputRowBudget(rows: number | undefined): number {
  return Math.max(3, rowsOrDefault(rows) - LIVE_REGION_CHROME_ROWS);
}

/** Visible rows of a queued/steered message block. */
export function queueRowBudget(rows: number | undefined): number {
  return Math.max(1, Math.min(5, rowsOrDefault(rows) - LIVE_REGION_CHROME_ROWS));
}

/**
 * A window of at most `maxVisible` entries out of `total` that keeps
 * `selected` inside it, centred where possible. Same behaviour as
 * InlineSelector's: short lists never scroll.
 */
export function windowAround(
  selected: number,
  total: number,
  maxVisible: number
): { start: number; end: number } {
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(maxVisible / 2), total - maxVisible)
  );
  return { start, end: Math.min(total, start + maxVisible) };
}

// SGR sequences only - the only kind marked-terminal/chalk emit.
// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[[0-9;]*m/g;

/**
 * Terminal rows a single line occupies once wrapped at `width` columns.
 * An approximation: it counts UTF-16 code units, so wide (CJK/emoji)
 * characters are undercounted - the chrome budget's slack absorbs that.
 */
export function visualRows(line: string, width: number): number {
  const visible = line.replace(SGR_RE, "").length;
  return Math.max(1, Math.ceil(visible / Math.max(1, width)));
}

/**
 * Keeps the tail of `text` that fits in `maxRows` wrapped rows, prefixed with
 * a "…" line when anything was dropped (that marker's row is counted). A
 * single line too long to fit whole keeps only its last characters, so one
 * long streamed paragraph can't blow the budget on its own - counting
 * logical lines alone (what this replaced) let six long paragraphs wrap into
 * thirty-odd rows.
 */
export function tailByRows(
  text: string,
  maxRows: number,
  width: number | undefined
): string {
  const cols = Math.max(1, width && width > 0 ? width : DEFAULT_COLUMNS);
  const lines = text.split("\n");
  const total = lines.reduce((sum, line) => sum + visualRows(line, cols), 0);
  if (total <= maxRows) {
    return text;
  }

  const budget = Math.max(1, maxRows - 1); // one row for the "…" marker
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0 && used < budget; i--) {
    const line = lines[i];
    const rows = visualRows(line, cols);
    if (used + rows <= budget) {
      kept.unshift(line);
      used += rows;
    } else {
      const remainingChars = (budget - used) * cols;
      kept.unshift(line.slice(line.length - remainingChars));
      used = budget;
    }
  }
  return `…\n${kept.join("\n")}`;
}

export interface RowSegment {
  type: "text" | "code";
  content: string;
}

// A code segment is drawn in a classic border (top + bottom rows) with a
// bottom margin, and its sides take 4 columns (border + paddingX).
const CODE_SEGMENT_CHROME_ROWS = 3;
const CODE_SEGMENT_CHROME_COLUMNS = 4;

/**
 * Second-stage clamp, applied after markdown rendering: rendering can make
 * text taller than the raw markdown it came from (a table grows border rows,
 * a code fence grows a box). Drops whole lines from the top until the
 * segments fit in `maxRows`.
 */
export function clampSegmentsToRows<T extends RowSegment>(
  segments: T[],
  maxRows: number,
  width: number | undefined
): T[] {
  const cols = Math.max(1, width && width > 0 ? width : DEFAULT_COLUMNS);
  const out: T[] = [];
  let used = 0;
  for (let i = segments.length - 1; i >= 0 && used < maxRows; i--) {
    const segment = segments[i];
    const isCode = segment.type === "code";
    const chrome = isCode ? CODE_SEGMENT_CHROME_ROWS : 0;
    const lineWidth = isCode ? cols - CODE_SEGMENT_CHROME_COLUMNS : cols;
    const lines = segment.content.split("\n");
    const kept: string[] = [];
    let segmentRows = chrome;
    for (let j = lines.length - 1; j >= 0; j--) {
      const rows = visualRows(lines[j], lineWidth);
      if (used + segmentRows + rows > maxRows) {
        break;
      }
      kept.unshift(lines[j]);
      segmentRows += rows;
    }
    if (kept.length === 0) {
      break;
    }
    out.unshift({ ...segment, content: kept.join("\n") });
    used += segmentRows;
    if (kept.length < lines.length) {
      break;
    }
  }
  return out;
}
