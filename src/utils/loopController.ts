/**
 * Parsing and limits for `/loop` (and the headless `--loop`), which re-sends
 * a prompt to the agent on a fixed interval.
 *
 * Everything here is pure, so the interval and cap arithmetic is testable
 * without a terminal or a live agent - which matters more than usual, since
 * the failure mode of getting it wrong is an unattended loop quietly
 * spending a credit balance.
 */

// A loop is unattended by definition, so both ends are clamped. The floor
// exists because a turn plus its tool calls rarely finishes inside 30s -
// anything faster would spend most of its ticks being skipped for being
// busy, which is just a confusing way to burn credits. The ceiling is there
// so a typo can't arm something that fires next week.
export const MIN_LOOP_INTERVAL_MS = 30_000;
export const MAX_LOOP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Hard stop on total iterations, so a loop left running overnight ends by
// itself. Deliberately not configurable upward from the slash command:
// a longer run is what a bigger interval is for.
export const DEFAULT_MAX_LOOP_RUNS = 50;
export const MAX_LOOP_RUNS_CEILING = 500;

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const INTERVAL_PATTERN = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)$/i;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
};

export function formatInterval(ms: number): string {
  if (ms % 3_600_000 === 0) {
    return `${ms / 3_600_000}h`;
  }
  if (ms % 60_000 === 0) {
    return `${ms / 60_000}m`;
  }
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Parses an interval like "30s", "5m" or "2h" into milliseconds.
 *
 * A unit is required. A bare number is rejected rather than assumed to be
 * seconds or minutes - the two differ by 60x here, and guessing wrong in
 * either direction is expensive (a "5" meant as minutes, run as seconds,
 * is 60 turns instead of 1).
 */
export function parseInterval(raw: string): ParseResult<number> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "No interval given. Example: /loop 5m <prompt>" };
  }

  const match = INTERVAL_PATTERN.exec(trimmed);
  if (!match) {
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return {
        ok: false,
        error: `"${trimmed}" needs a unit - write ${trimmed}s for seconds or ${trimmed}m for minutes.`,
      };
    }
    return {
      ok: false,
      error: `Could not read "${trimmed}" as an interval. Use a number and a unit, e.g. 30s, 5m or 2h.`,
    };
  }

  const ms = Math.round(parseFloat(match[1]) * UNIT_MS[match[2].toLowerCase()]);

  if (ms < MIN_LOOP_INTERVAL_MS) {
    return {
      ok: false,
      error: `Interval too short: minimum is ${formatInterval(
        MIN_LOOP_INTERVAL_MS
      )} (a turn rarely finishes faster, so shorter ticks would just be skipped).`,
    };
  }
  if (ms > MAX_LOOP_INTERVAL_MS) {
    return {
      ok: false,
      error: `Interval too long: maximum is ${formatInterval(
        MAX_LOOP_INTERVAL_MS
      )}.`,
    };
  }

  return { ok: true, value: ms };
}

export type LoopCommand =
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "start"; intervalMs: number; prompt: string; maxRuns: number };

/**
 * Parses the argument string of `/loop`.
 *
 * Forms:
 *   /loop                     -> status
 *   /loop stop                -> stop
 *   /loop 5m <prompt>         -> start
 *   /loop 5m x20 <prompt>     -> start, capped at 20 runs
 */
export function parseLoopCommand(args: string): ParseResult<LoopCommand> {
  const trimmed = (args ?? "").trim();

  if (!trimmed) {
    return { ok: true, value: { kind: "status" } };
  }
  if (/^(stop|off|cancel)$/i.test(trimmed)) {
    return { ok: true, value: { kind: "stop" } };
  }

  const [intervalToken, ...restTokens] = trimmed.split(/\s+/);
  const interval = parseInterval(intervalToken);
  if (!interval.ok) {
    return interval;
  }

  let maxRuns = DEFAULT_MAX_LOOP_RUNS;
  // Optional run cap immediately after the interval, written x20 or 20x so
  // it can't be mistaken for the start of the prompt.
  if (restTokens.length > 0) {
    const capMatch = /^x(\d+)$|^(\d+)x$/i.exec(restTokens[0]);
    if (capMatch) {
      const requested = parseInt(capMatch[1] ?? capMatch[2], 10);
      if (requested < 1 || requested > MAX_LOOP_RUNS_CEILING) {
        return {
          ok: false,
          error: `Run cap must be between 1 and ${MAX_LOOP_RUNS_CEILING}.`,
        };
      }
      maxRuns = requested;
      restTokens.shift();
    }
  }

  const prompt = restTokens.join(" ").trim();
  if (!prompt) {
    return {
      ok: false,
      error: `No prompt given. Example: /loop ${formatInterval(
        interval.value
      )} check CI and fix any failures`,
    };
  }

  return {
    ok: true,
    value: { kind: "start", intervalMs: interval.value, prompt, maxRuns },
  };
}

export interface LoopState {
  // Stable across run-count changes, so the timer effect can key on it
  // without being torn down and rebuilt on every tick.
  id: string;
  intervalMs: number;
  prompt: string;
  runs: number;
  maxRuns: number;
  // Ticks that fired while the previous one was still in flight. Surfaced
  // rather than hidden: a loop that skips most of its ticks is set too fast.
  skipped: number;
}

export function describeLoop(loop: LoopState): string {
  const skipped =
    loop.skipped > 0
      ? `, ${loop.skipped} skipped (agent still busy)`
      : "";
  return `every ${formatInterval(loop.intervalMs)} (${loop.runs}/${
    loop.maxRuns
  }${skipped})`;
}

/**
 * Title row for the persistent "Looping" block under the input, styled like
 * the Queued and Steered blocks (see Conversation.tsx).
 *
 * Kept here rather than inline in the component so the state it has to
 * convey - how many runs have gone, whether a tick is waiting, how many were
 * skipped - is covered by the same tests as the rest of the loop logic.
 *
 * `maxWidth` is how many characters the block can actually paint. The block
 * hard-truncates anything longer, and for this title the tail is the part
 * that says how to stop the loop - the worst thing to lose off the end. So
 * rather than let it be cut, optional segments are dropped in reverse
 * priority until it fits: the static cancel hint goes first (it doesn't
 * change, and /loop status repeats it), then the queued-tick note, then the
 * skip count. The run counter and interval always survive, since those are
 * what tell you what the loop is about to cost.
 */
export function loopBlockTitle(
  loop: LoopState,
  hasQueuedTick: boolean,
  maxWidth?: number
): string {
  const essential = `Looping (${loop.runs}/${loop.maxRuns}) — every ${formatInterval(
    loop.intervalMs
  )}`;

  // Highest priority last, so popping trims the least important first.
  const optional: string[] = [];
  if (loop.skipped > 0) {
    optional.push(`· ${loop.skipped} skipped (agent busy)`);
  }
  if (hasQueuedTick) {
    optional.push("· next run queued");
  }
  optional.push("· Esc or /loop stop to cancel");

  // Rendered order is fixed regardless of what survives: queued state, then
  // skips, then the hint.
  const order = (kept: string[]) =>
    [
      essential,
      kept.find((s) => s.includes("next run queued")),
      kept.find((s) => s.includes("skipped")),
      kept.find((s) => s.includes("cancel")),
    ]
      .filter(Boolean)
      .join(" ");

  const kept = [...optional];
  let title = order(kept);
  while (maxWidth !== undefined && title.length > maxWidth && kept.length > 0) {
    kept.pop();
    title = order(kept);
  }
  return title;
}
