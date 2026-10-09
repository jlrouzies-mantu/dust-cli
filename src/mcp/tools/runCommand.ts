import { z } from "zod";

import { executeCommand } from "../../utils/command.js";
import {
  PLAN_MODE_TOOL_NOTICE,
  isPlanModeActive,
  planModeRefusal,
} from "../../utils/planMode.js";
import {
  escapingCommandOperands,
  resolveInSandbox,
} from "../../utils/sandbox.js";
import type { McpTool } from "../types/tools.js";

export class RunCommandTool implements McpTool {
  name = "run_command";
  stake = "high" as const;
  description =
    "Executes a shell command directly on the user's local machine (the real OS and filesystem the CLI itself is " +
    "running on), NOT a hosted/sandboxed execution environment. Use this - never a hosted code interpreter or " +
    "isolated sandbox - whenever the user asks you to run a command, script, build, or test in their actual project. " +
    "Defaults to the CLI's current working directory when `cwd` is omitted. Returns structured output with exit " +
    "code, stdout, stderr, and command info. " +
    "Commands are scoped to the workspace the CLI was started in: arguments pointing outside it are refused." +
    PLAN_MODE_TOOL_NOTICE;

  inputSchema = z.object({
    command: z
      .string()
      .describe(
        "The base command to execute (e.g., 'npm', 'git', 'ls', 'python')"
      ),
    args: z
      .array(z.string())
      .optional()
      .describe(
        "Command arguments as separate array elements (e.g., ['install', '--save-dev', 'typescript'] for 'npm install --save-dev typescript')"
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        "Working directory path to run command in. If not provided, uses current directory"
      ),
    timeout: z
      .number()
      .optional()
      .describe(
        "Timeout in milliseconds (default: 30000). Use higher values for long-running commands like builds or installs"
      ),
  });

  async execute({
    command,
    args = [],
    cwd,
    timeout = 30000,
  }: z.infer<typeof this.inputSchema>) {
    // Blocked wholesale while planning, not filtered by command. There is no
    // reliable way to tell a read-only invocation from a mutating one -
    // `git log` is harmless, `git reset --hard` is not, and both arrive here
    // as the same shape - and an allowlist would be a security boundary this
    // code is not in a position to enforce (shell metacharacters, aliases,
    // scripts that shell out further). Research is done with read_file,
    // search_files and search_content instead; the refusal says so.
    if (isPlanModeActive()) {
      return {
        content: [{ type: "text" as const, text: planModeRefusal(this.name) }],
        isError: true,
      };
    }

    const cwdRes = resolveInSandbox(cwd ?? process.cwd());
    if (cwdRes.isErr()) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${cwdRes.error.message}` },
        ],
        isError: true,
      };
    }
    const workingDirectory = cwdRes.value;

    const escaping = escapingCommandOperands(args, workingDirectory);
    if (escaping.length > 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Error: refusing to run ${command}, it targets paths outside the workspace: ` +
              `${escaping.join(", ")}. Restart the CLI with --allow-path to grant access.`,
          },
        ],
        isError: true,
      };
    }

    const cmdRes = await executeCommand(
      command,
      args,
      workingDirectory,
      timeout,
      true
    );

    if (cmdRes.isErr()) {
      const error = cmdRes.error;
      const output = [
        `Command failed: ${
          error.command || `${command} ${args?.join(" ") || ""}`
        }`,
        `Exit code: ${error.exitCode ?? "unknown"}`,
        error.stdout && `\nSTDOUT:\n${error.stdout}`,
        error.stderr && `\nSTDERR:\n${error.stderr}`,
        error.message && `\nError: ${error.message}`,
      ]
        .filter(Boolean)
        .join("\n");

      return {
        content: [{ type: "text" as const, text: output }],
        isError: true,
      };
    }

    const result = cmdRes.value;
    const output = [
      `Command: ${result.command}`,
      `Exit code: ${result.exitCode}`,
      result.stdout && `\nSTDOUT:\n${result.stdout}`,
      result.stderr && `\nSTDERR:\n${result.stderr}`,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      content: [{ type: "text" as const, text: output }],
    };
  }
}
