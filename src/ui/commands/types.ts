export interface CommandContext {
  triggerAgentSwitch?: () => void;
  attachFile?: () => void;
  clearFiles?: () => void;
  toggleAutoEdits?: () => void;
  startNewConversation?: () => void;
  showHelp?: () => void;
  resumeConversation?: () => void;
  toggleClaudeCodeMode?: () => void;
  runLoopCommand?: (args: string) => void;
  togglePlanMode?: () => void;
  runTasksCommand?: () => void;
  // args present -> force that skill's body into the next message; absent
  // -> list what's on disk. One command, not two ("/skills"/"/skill"),
  // because the command dispatcher prefix-matches with no exact-match
  // preference (see Chat.tsx's command filtering) - two names where one is
  // a prefix of the other would silently run whichever is declared first
  // and drop the argument.
  runSkillsCommand?: (args?: string) => void;
}

export interface Command {
  name: string;
  description: string;
  /**
   * `args` is whatever followed the command name on the line: typing
   * `/loop 5m check CI` calls `/loop`'s execute with `"5m check CI"`.
   * Commands that take no arguments simply ignore it.
   *
   * Note there is no context parameter: every command closes over the
   * context passed to createCommands below. It previously took one, but
   * every implementation ignored it in favour of the closure, and the call
   * site passed an incomplete object - a trap for the next person to add a
   * command.
   */
  execute: (args?: string) => void | Promise<void>;
  // Argument syntax, shown in the selector. Present only on commands that
  // take arguments.
  usage?: string;
}

/**
 * Splits what the user typed after `/` into a command name and its
 * arguments. `"loop 5m check CI"` -> `["loop", "5m check CI"]`.
 *
 * The command selector filters on the name alone, so the menu keeps showing
 * `/loop` while arguments are still being typed instead of going empty on
 * the first space.
 */
export function splitCommandQuery(query: string): [name: string, args: string] {
  const firstSpace = query.search(/\s/);
  if (firstSpace === -1) {
    return [query, ""];
  }
  return [query.slice(0, firstSpace), query.slice(firstSpace + 1)];
}

export const createCommands = (context: CommandContext): Command[] => [
  {
    name: "help",
    description: "Show commands and keyboard shortcuts",
    execute: () => {
      if (context.showHelp) {
        context.showHelp();
      }
    },
  },
  {
    name: "switch",
    description: "Switch to a different agent",
    execute: () => {
      if (context.triggerAgentSwitch) {
        context.triggerAgentSwitch();
      }
    },
  },
  {
    name: "new",
    description: "Start a new conversation",
    execute: () => {
      if (context.startNewConversation) {
        context.startNewConversation();
      }
    },
  },
  {
    name: "clear",
    description: "Clear the screen and start a new conversation",
    execute: () => {
      if (context.startNewConversation) {
        context.startNewConversation();
      }
    },
  },
  {
    name: "resume",
    description: "Resume a recent conversation",
    execute: () => {
      if (context.resumeConversation) {
        context.resumeConversation();
      }
    },
  },
  {
    name: "attach",
    description: "Open file selector to attach a file",
    execute: () => {
      if (context.attachFile) {
        context.attachFile();
      }
    },
  },
  {
    name: "clear-files",
    description: "Clear any attached files",
    execute: () => {
      if (context.clearFiles) {
        context.clearFiles();
      }
    },
  },
  {
    name: "loop",
    description: "Re-send a prompt on an interval (/loop stop to cancel)",
    usage: "<interval> [xN] <prompt>",
    execute: (args) => {
      if (context.runLoopCommand) {
        context.runLoopCommand(args ?? "");
      }
    },
  },
  {
    name: "claude-code-mode",
    description: "Toggle priming the agent with your Claude Code memories",
    execute: () => {
      if (context.toggleClaudeCodeMode) {
        context.toggleClaudeCodeMode();
      }
    },
  },
  {
    name: "auto",
    description: "Toggle auto-approval of file edits on/off (Shift+Tab cycles)",
    execute: () => {
      if (context.toggleAutoEdits) {
        context.toggleAutoEdits();
      }
    },
  },
  {
    name: "plan",
    description:
      "Toggle plan mode - research only until you approve a plan (Shift+Tab cycles)",
    execute: () => {
      if (context.togglePlanMode) {
        context.togglePlanMode();
      }
    },
  },
  {
    name: "tasks",
    description: "Show the current task list for this conversation",
    execute: () => {
      if (context.runTasksCommand) {
        context.runTasksCommand();
      }
    },
  },
  {
    name: "skills",
    description:
      "List local skills, or force one into your next message (/skills <name>)",
    usage: "[name]",
    execute: (args) => {
      if (context.runSkillsCommand) {
        context.runSkillsCommand(args);
      }
    },
  },
  {
    name: "exit",
    description: "Exit the chat",
    execute: () => {
      process.exit(0);
    },
  },
];
