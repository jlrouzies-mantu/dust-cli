export function clearTerminal(): Promise<void> {
  return new Promise((resolve) => {
    // \x1b[2J clears the visible screen, \x1b[H moves the cursor home.
    // Deliberately not sending \x1b[3J here — that erases the terminal's
    // actual scrollback buffer, wiping out everything the user had above
    // (their shell history, prior output, ...), not just this app's view.
    // Use clearTerminalAndScrollback() for the cases where that full wipe
    // is what's actually wanted.
    //
    // \x1b[0m goes first: \x1b[2J only erases visible *content*, it doesn't
    // touch the terminal's active text attributes - whatever color/style
    // was last set (e.g. the status bar's purple workspace segment) stays
    // "on" straight through the clear. Since this write happens outside
    // Ink's own render cycle, Ink's next frame has no idea the terminal's
    // attribute state didn't actually reset along with the visible screen,
    // and its diffing can skip re-emitting a color for a segment it thinks
    // is unchanged - which is what let old colors bleed into unrelated
    // status bar fields after a resume (branch/context rendering in
    // whatever was last active instead of their own colors). Resetting
    // attributes explicitly here closes that gap regardless of what Ink's
    // diff decides to skip.
    process.stdout.write("\x1b[0m\x1b[2J\x1b[H", () => {
      resolve();
    });
  });
}

/**
 * Clears the visible screen *and* the terminal's scrollback buffer, so
 * nothing can be scrolled back to - a genuine blank slate.
 *
 * Used where a fresh start is the explicit intent (launching the chat,
 * `/new`, `/clear`) rather than just re-rendering this app's own view. Note
 * this does discard whatever the user had in their terminal beforehand
 * (shell history, earlier command output) - that's the point, but it's why
 * the plain clearTerminal() above still exists for the in-app re-render
 * cases, which shouldn't be that destructive.
 */
export function clearTerminalAndScrollback(): Promise<void> {
  return new Promise((resolve) => {
    // \x1b[0m first - see clearTerminal() above for why.
    process.stdout.write("\x1b[0m\x1b[2J\x1b[3J\x1b[H", () => {
      resolve();
    });
  });
}
