export function clearTerminal(): Promise<void> {
  return new Promise((resolve) => {
    // \x1b[2J clears the visible screen, \x1b[H moves the cursor home.
    // Deliberately not sending \x1b[3J here — that erases the terminal's
    // actual scrollback buffer, wiping out everything the user had above
    // (their shell history, prior output, ...), not just this app's view.
    process.stdout.write("\x1b[2J\x1b[H", () => {
      resolve();
    });
  });
}
