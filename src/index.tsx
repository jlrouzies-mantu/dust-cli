#!/usr/bin/env node

import { ANSI_RESET, ansiForegroundFor } from "./utils/color.js";
import {
  PULSE_COLOR_FRAMES,
  PULSE_ICON,
  PULSE_INTERVAL_MS,
} from "./utils/pulse.js";

// Print immediate feedback before pulling in the ink/react/App dependency
// graph below - resolving and loading that many transitive node_modules can
// itself take a few seconds on a cold Windows start (AV file-scan overhead
// in particular), and static imports are hoisted ahead of everything else
// in this file, so without this the terminal would show nothing at all
// during that window, making the CLI look stuck before it even gets a
// chance to render its own "Loading" spinner. Dynamic `import()` is what
// lets this line run first.
//
// The glyph pulses through the same brand colors as the in-app Thinking
// indicator (shared via ./utils/pulse.js, which is dependency-free for
// exactly this reason - importing ThinkingIcon here would drag in all of
// Ink and defeat the point). Redrawn in place with a carriage return, so no
// newline is emitted until the animation stops.
// -m/--message runs non-interactively and its output can be piped/parsed
// by the caller - the pulsing "Starting dustm..." line (and the logger
// init below) is interactive-only chrome that shouldn't appear in that
// path.
const isNonInteractiveMessage =
  process.argv.includes("-m") || process.argv.includes("--message");

const isInteractiveStdout = Boolean(process.stdout.isTTY);
let pulseFrame = 0;
const writeStartupLine = () => {
  const color = ansiForegroundFor(
    PULSE_COLOR_FRAMES[pulseFrame % PULSE_COLOR_FRAMES.length]
  );
  process.stdout.write(
    `\r${color}${PULSE_ICON}${ANSI_RESET} Starting dustm...`
  );
};
if (!isNonInteractiveMessage) {
  writeStartupLine();
}
// Only animate on a real terminal: with output piped or redirected, \r
// rewrites would pile up as repeated junk in the captured text.
const pulseTimer =
  isInteractiveStdout && !isNonInteractiveMessage
    ? setInterval(() => {
        pulseFrame++;
        writeStartupLine();
      }, PULSE_INTERVAL_MS)
    : null;
// Don't let this timer hold the event loop open on its own.
pulseTimer?.unref();

import { initLogger, registerInkCleanup } from "./utils/logger.js";

if (!isNonInteractiveMessage) {
  initLogger();
}

const [{ render }, { default: meow }, { createElement }, { default: App }] =
  await Promise.all([
    import("ink"),
    import("meow"),
    import("react"),
    import("./ui/App.js"),
  ]);

// Loading is done - stop pulsing and close off the line so anything printed
// next (Ink's first frame, or a one-shot command's output) starts cleanly on
// its own row rather than overwriting this one.
if (pulseTimer) {
  clearInterval(pulseTimer);
}
if (!isNonInteractiveMessage) {
  process.stdout.write("\n");
}

const cli = meow({
  importMeta: import.meta,
  autoHelp: false,
  autoVersion: false,
  flags: {
    version: {
      type: "boolean",
      shortFlag: "v",
    },
    force: {
      type: "boolean",
      shortFlag: "f",
    },
    help: {
      type: "boolean",
    },
    port: {
      type: "number",
      shortFlag: "p",
      description: "Specify the port for the MCP server",
    },
    sId: {
      type: "string",
      shortFlag: "s",
      isMultiple: true,
      description: "Specify agent sId(s) to use directly (can be repeated)",
    },
    agent: {
      type: "string",
      shortFlag: "a",
      description: "Search for and use an agent by name",
    },
    message: {
      type: "string",
      shortFlag: "m",
      description: "Send a message to the agent non-interactively",
    },
    conversationId: {
      type: "string",
      shortFlag: "c",
      description:
        "Conversation ID (use with --agent and --message, or with --messageId)",
    },
    messageId: {
      type: "string",
      description:
        "Display details of a specific message (requires --conversationId)",
    },
    details: {
      type: "boolean",
      shortFlag: "d",
      description:
        "Show detailed message information (requires --agent and --message)",
    },
    auto: {
      type: "boolean",
      description:
        "Always accept edit operations without prompting for approval",
    },
    plan: {
      type: "boolean",
      description:
        "Start the chat in plan mode: the agent researches read-only and must get a plan approved before editing anything",
    },
    noUpdateCheck: {
      type: "boolean",
      description: "Skip update check",
    },
    key: {
      type: "string",
      description: "Dust API key for headless authentication",
    },
    workspaceId: {
      type: "string",
      description: "Workspace ID for headless authentication",
    },
    resume: {
      type: "string",
      shortFlag: "r",
      description:
        "Resume a conversation by ID, or pass no value to pick from recent",
    },
    projectName: {
      type: "string",
      description: "Create conversation in a project by name",
    },
    projectId: {
      type: "string",
      description: "Create conversation in a project by space ID",
    },
    withTools: {
      type: "boolean",
      shortFlag: "t",
      description:
        "Enable file system tools in non-interactive mode (requires OAuth). WARNING: automatically approves ALL tool executions without prompting.",
    },
    loop: {
      type: "string",
      description:
        "Re-send --message on an interval (e.g. 5m, 30s, 2h). Requires --message. WARNING: each run spends credits.",
    },
    maxRuns: {
      type: "number",
      description:
        "Maximum runs for --loop (default 50). Each run is a full agent turn.",
    },
    loopFreshConversation: {
      type: "boolean",
      description:
        "Start each --loop run in a new conversation instead of continuing the same one",
    },
  },
});

// Ink's default exitOnCtrlC kills the process on the very first Ctrl+C
// with no chance for the app to react — losing an in-progress chat with
// no warning. Disabled here; App.tsx and Chat.tsx implement their own
// (safer) Ctrl+C handling instead.
const instance = render(createElement(App, { cli }), {
  exitOnCtrlC: false,
});
registerInkCleanup(() => instance.unmount());
