/**
 * Tab title and taskbar progress, so a `dustm` you've tabbed away from can
 * still tell you what it's doing.
 *
 * Two independent mechanisms, both OSC ("operating system command") escape
 * sequences:
 *
 * - **OSC 0** sets the window/tab title. Understood by Windows Terminal
 *   (which uses it for the tab label), by legacy conhost (window title), and
 *   by essentially every xterm-descended terminal.
 * - **OSC 9;4** sets the taskbar/tab progress indicator - the ConEmu
 *   convention Windows Terminal adopted. This is the part that shows a
 *   *state* rather than text: a pulsing ring on the tab while the agent
 *   works, red on error. Nothing else available to a console app on Windows
 *   gives that.
 *
 * Both are safe to emit blind. A terminal that doesn't recognise an OSC
 * consumes and discards it - it isn't rendered as garbage the way an unknown
 * *glyph* would be, so unlike the CP437 care taken over the status bar's
 * gauges, there's no legacy-console downside here. A terminal that supports
 * the title but not OSC 9;4 (conhost) ignores the latter and keeps the
 * former, which is why the two are layered rather than either/or.
 *
 * Unlike clearTerminal()'s raw writes, these don't disturb Ink: they emit no
 * printable cells, move no cursor and change no text attributes, so Ink's
 * render diffing has nothing to get out of step with. The reason
 * clearTerminal() needs its `\x1b[0m` dance doesn't apply here.
 */

// BEL terminates the OSC. ST (ESC + backslash) is the more correct
// terminator, but BEL is what conhost has always accepted and Windows
// Terminal takes both.
const BEL = String.fromCharCode(7);
const OSC = `${String.fromCharCode(27)}]`;

const ENABLED =
  Boolean(process.stdout.isTTY) &&
  // An explicit escape hatch, for a terminal that renders these badly or a
  // user who simply doesn't want their tab relabelled.
  process.env.DUSTM_NO_TITLE !== "1" &&
  // The conventional "I understand no escape sequences" flag.
  process.env.TERM !== "dumb";

// C0 (which includes ESC and BEL), DEL, and C1. Written as explicit unicode
// escapes rather than literal characters so the source stays plain text and
// the intent survives any editor, diff or copy-paste that would eat them.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL_CHARS = new RegExp(
  `[\u0000-\u001f\u007f-\u009f]`,
  "g"
);

/**
 * Strips anything that could terminate or escape the OSC sequence this text
 * is about to be wrapped in.
 *
 * Not cosmetic tidying: the title carries a summary of the user's own
 * message, so a stray BEL, ESC or newline in what they typed - or pasted,
 * which this CLI explicitly supports - would close the sequence early and
 * leave the remainder to be interpreted as terminal commands. Removing the
 * whole control range is the blunt, reliable fix.
 */
function sanitize(text: string): string {
  return text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

function write(sequence: string): void {
  if (!ENABLED) {
    return;
  }
  try {
    process.stdout.write(sequence);
  } catch {
    // A closed or broken stdout must never take the CLI down over a
    // decoration.
  }
}

/** Sets the terminal's window/tab title. */
export function setTerminalTitle(title: string): void {
  const clean = sanitize(title);
  if (!clean) {
    return;
  }
  // OSC 0 sets icon name *and* window title. OSC 2 would set only the
  // latter, but some terminals key their tab label off the icon name, so 0
  // is the one that works in the most places.
  write(`${OSC}0;${clean}${BEL}`);
}

/**
 * Hands the title back to the shell on exit.
 *
 * There's no "restore previous title" sequence - the original isn't readable
 * in any portable way - so this sets an empty title, which terminals treat
 * as "revert to your default". Most shells overwrite it at the next prompt
 * anyway; this covers the ones that wouldn't, so a closed session doesn't
 * leave a stale "working" label behind.
 */
export function resetTerminalTitle(): void {
  write(`${OSC}0;${BEL}`);
}

/**
 * Taskbar/tab progress state (OSC 9;4), Windows Terminal's ConEmu-derived
 * indicator.
 *
 * - `none` removes it
 * - `indeterminate` pulses with no percentage - the right shape for "the
 *   agent is working", whose duration is genuinely unknown
 * - `error` / `warning` tint it red / yellow
 */
export type TaskbarProgress = "none" | "indeterminate" | "error" | "warning";

const PROGRESS_STATE: Record<TaskbarProgress, number> = {
  none: 0,
  indeterminate: 3,
  error: 2,
  warning: 4,
};

export function setTaskbarProgress(state: TaskbarProgress): void {
  // The trailing 0 is the percentage field. It's meaningless for every state
  // used here, but the sequence is malformed without it.
  write(`${OSC}9;4;${PROGRESS_STATE[state]};0${BEL}`);
}

/** Clears both decorations. Safe to call more than once. */
export function clearTerminalDecorations(): void {
  setTaskbarProgress("none");
  resetTerminalTitle();
}

// Tab-title state icons. Drawn from the same geometric family as the status
// bar's mode indicators rather than emoji, so the CLI reads as one thing.
// Unlike the status bar's gauges these are drawn by the terminal's own
// title-bar font rather than the console grid, so the CP437 constraint that
// shapes those glyphs doesn't apply here.
export const TAB_ICON_WORKING = "●"; // filled circle - busy
export const TAB_ICON_DONE = "✓"; // check - finished, not yet seen
export const TAB_ICON_NEEDS_YOU = "◆"; // filled diamond - blocked on you
export const TAB_ICON_ERROR = "✗"; // ballot X - failed

export interface TabState {
  agentName: string;
  /** What the agent is doing, or the folder when nothing has been sent yet. */
  subject: string;
  isWorking: boolean;
  /** An approval prompt is up mid-turn, so the agent is blocked on the user. */
  isBlockedOnUser: boolean;
  hasError: boolean;
  /** The sticky "a turn ended and you haven't looked yet" marker. */
  turnFinished: boolean;
}

export interface TabDecoration {
  title: string;
  progress: TaskbarProgress;
}

/**
 * The tab's state machine, kept pure and separate from the React effect that
 * drives it so the precedence below is testable and stated in one place.
 *
 * Ordered by urgency rather than by how the UI renders: an approval prompt
 * waiting mid-turn is the one state where the agent is genuinely blocked on
 * the user, so it outranks "working" even though both are true at once.
 */
export function describeTab(state: TabState): TabDecoration {
  const { agentName, subject } = state;

  if (state.isWorking && state.isBlockedOnUser) {
    return {
      title: `${TAB_ICON_NEEDS_YOU} ${agentName} - needs you`,
      progress: "warning",
    };
  }
  if (state.isWorking) {
    return {
      title: `${TAB_ICON_WORKING} ${agentName} - ${subject}`,
      progress: "indeterminate",
    };
  }
  if (state.hasError) {
    return {
      title: `${TAB_ICON_ERROR} ${agentName} - error`,
      progress: "error",
    };
  }
  if (state.turnFinished) {
    return {
      title: `${TAB_ICON_DONE} ${agentName} - ${subject}`,
      progress: "none",
    };
  }
  return { title: `${agentName} - ${subject}`, progress: "none" };
}

let cleanupRegistered = false;

/**
 * Ensures the tab doesn't keep a "working" label or a pulsing progress ring
 * after the process is gone.
 *
 * Registered on `exit`, which covers a normal quit, Ctrl+C's second press,
 * and the uncaughtException path in logger.ts (which calls process.exit
 * itself). `exit` handlers must be synchronous, which a bare stdout.write
 * is.
 */
export function registerTerminalTitleCleanup(): void {
  if (cleanupRegistered || !ENABLED) {
    return;
  }
  cleanupRegistered = true;
  process.on("exit", () => {
    clearTerminalDecorations();
  });
}
