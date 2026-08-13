import fs from "fs";
import path from "path";
import { z } from "zod";

import { normalizeError } from "../../utils/errors.js";
import {
  PLAN_MODE_TOOL_NOTICE,
  isPlanModeActive,
  planModeRefusal,
} from "../../utils/planMode.js";
import type { McpTool } from "../types/tools.js";

export class WriteFileTool implements McpTool {
  name = "write_file";
  private diffApprovalCallback?: (
    originalContent: string,
    updatedContent: string,
    filePath: string
  ) => Promise<boolean>;

  description =
    "Creates a new file, or overwrites an existing one, directly on the user's local machine " +
    "in the current working directory the CLI is running from. " +
    "ALWAYS use this tool (instead of any hosted/interactive file generation feature) whenever the user " +
    "asks you to create, save, or write a file - the user is working in a terminal and expects the " +
    "file to land on disk where they can see and edit it, not in a web-only preview. " +
    "Requirements for mandatory parameters:\n" +
    "1. `path` NEEDS TO use absolute path notation; relative paths will trigger an error.\n" +
    "2. `content` NEEDS TO contain the complete, final content of the file - this tool does not merge " +
    "or append, it writes the full file contents.\n\n" +
    "If the file already exists, prefer the edit_file tool for targeted changes; this tool will fully " +
    "overwrite it. Parent directories are created automatically if they do not exist." +
    PLAN_MODE_TOOL_NOTICE;

  inputSchema = z.object({
    path: z
      .string()
      .describe(
        "The complete absolute file path (example: '/home/user/project/file.txt') for the file to create or overwrite. Relative paths are not supported. Must provide full absolute path."
      ),
    content: z
      .string()
      .describe(
        "The complete content to write to the file. This replaces the entire file contents."
      ),
  });

  setDiffApprovalCallback(
    callback: (
      originalContent: string,
      updatedContent: string,
      filePath: string
    ) => Promise<boolean>
  ) {
    this.diffApprovalCallback = callback;
  }

  async execute({
    path: filePath,
    content,
  }: z.infer<typeof this.inputSchema>) {
    try {
      // Checked before anything else, including path validation: while
      // planning, the answer is the same regardless of whether the arguments
      // were well-formed, and a validation error would misleadingly suggest
      // that fixing the path would let the write through.
      if (isPlanModeActive()) {
        return {
          content: [
            { type: "text" as const, text: planModeRefusal(this.name) },
          ],
          isError: true,
        };
      }

      if (!path.isAbsolute(filePath)) {
        throw new Error(`Path must be absolute: ${filePath}`);
      }

      const fileExists = fs.existsSync(filePath);
      const originalContent = fileExists
        ? await fs.promises.readFile(filePath, "utf-8")
        : "";

      if (this.diffApprovalCallback) {
        const approved = await this.diffApprovalCallback(
          originalContent,
          content,
          filePath
        );
        if (!approved) {
          return {
            content: [
              {
                type: "text" as const,
                text: `File write was rejected by user.`,
              },
            ],
          };
        }
      }

      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, content, "utf-8");

      const message = fileExists
        ? `Successfully overwrote ${filePath}`
        : `Successfully created ${filePath}`;

      return {
        content: [
          {
            type: "text" as const,
            text: message,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${normalizeError(error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
}
