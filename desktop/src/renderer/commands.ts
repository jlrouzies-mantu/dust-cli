/**
 * The slash commands, with the CLI's names, descriptions and argument syntax
 * (src/ui/commands/types.ts). Two additions exist only here: /normal and
 * /folder, which the desktop app needs because it has no launch directory
 * and no Shift+Tab-less way to return to normal mode.
 *
 * Execution lives in Composer.tsx (renderer-side commands) and
 * session.runCommand (commands whose logic is in the main process).
 */
export interface SlashCommand {
  name: string;
  description: string;
  /** Argument syntax; shown on the highlighted row. */
  usage?: string;
  /** Needs an argument to do anything: Enter completes instead of running. */
  requiresArgs?: boolean;
}

export const COMMANDS: SlashCommand[] = [
  { name: "help", description: "Show commands and keyboard shortcuts" },
  { name: "switch", description: "Switch to a different agent" },
  { name: "new", description: "Start a new conversation" },
  { name: "clear", description: "Clear the screen and start a new conversation" },
  { name: "resume", description: "Resume a recent conversation" },
  { name: "attach", description: "Open file selector to attach a file" },
  { name: "clear-files", description: "Clear any attached files" },
  {
    name: "loop",
    description: "Re-send a prompt on an interval (/loop stop to cancel)",
    usage: "<interval> [xN] <prompt>",
  },
  {
    name: "claude-code-mode",
    description: "Toggle priming the agent with your Claude Code memories",
  },
  {
    name: "auto",
    description: "Toggle auto-approval of file edits on/off (Shift+Tab cycles)",
  },
  {
    name: "plan",
    description:
      "Toggle plan mode - research only until you approve a plan (Shift+Tab cycles)",
  },
  { name: "tasks", description: "Show the current task list for this conversation" },
  {
    name: "skills",
    description: "List local skills, or force one into your next message (/skills <name>)",
    usage: "[name]",
  },
  {
    name: "model",
    description: "Override the model for this conversation (/model default to clear)",
    usage: "[model-id]",
  },
  {
    name: "compact",
    description: "Summarize this conversation server-side to free up context window",
    usage: "[model-id]",
  },
  {
    name: "effort",
    description: "Override the reasoning effort (high/medium/light/none, or default)",
    usage: "[level]",
  },
  {
    name: "btw",
    description:
      "Ask a quick side question - answered apart, never added to the conversation",
    usage: "<question>",
    requiresArgs: true,
  },
  { name: "exit", description: "Close the app" },
  // Desktop-only.
  { name: "normal", description: "Back to normal mode (you approve each edit)" },
  { name: "folder", description: "Choose the working folder" },
];

/** `"loop 5m check CI"` -> `["loop", "5m check CI"]` (types.ts splitCommandQuery). */
export function splitCommandQuery(query: string): [string, string] {
  const firstSpace = query.search(/\s/);
  if (firstSpace === -1) {
    return [query, ""];
  }
  return [query.slice(0, firstSpace), query.slice(firstSpace + 1)];
}

/** Prefix filter on the name alone, exactly as the CLI's selector does. */
export function filterCommands(nameQuery: string): SlashCommand[] {
  const q = nameQuery.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(q));
}

export function helpLines(): string[] {
  return [
    "Commands:",
    ...COMMANDS.map(
      (c) => `  /${c.name}${c.usage ? ` ${c.usage}` : ""}`.padEnd(34) + c.description
    ),
    "",
    "Shortcuts: Enter=send · Shift+Enter=newline · Shift+Tab=cycle mode · Esc=stop/close · Ctrl+K=commands · @=mention a file · Ctrl+V=paste image",
  ];
}
