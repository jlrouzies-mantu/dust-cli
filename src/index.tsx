#!/usr/bin/env node

import { MANTU_PURPLE } from "./utils/brand.js";

// Print immediate feedback before pulling in the ink/react/App dependency
// graph below - resolving and loading that many transitive node_modules can
// itself take a few seconds on a cold Windows start (AV file-scan overhead
// in particular), and static imports are hoisted ahead of everything else
// in this file, so without this the terminal would show nothing at all
// during that window, making the CLI look stuck before it even gets a
// chance to render its own "Loading" spinner. Dynamic `import()` is what
// lets this line run first. Styled by hand with a raw ANSI escape (rather
// than chalk/ink) so this print doesn't itself wait on anything heavier
// than ./utils/brand.js, which has zero dependencies.
function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const [r, g, b] = hexToRgb(MANTU_PURPLE);
process.stdout.write(`\x1b[38;2;${r};${g};${b}m♦\x1b[0m Starting dustm...\n`);

import { initLogger, registerInkCleanup } from "./utils/logger.js";

if (!process.argv.includes("-m") && !process.argv.includes("--message")) {
  initLogger();
}

const [{ render }, { default: meow }, { createElement }, { default: App }] =
  await Promise.all([
    import("ink"),
    import("meow"),
    import("react"),
    import("./ui/App.js"),
  ]);

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
