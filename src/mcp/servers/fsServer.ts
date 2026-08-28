import type { DustAPI, Result } from "@dust-tt/client";
import { Err, Ok } from "@dust-tt/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { PlanDecision } from "../../utils/planMode.js";
import { retryResult } from "../../utils/retry.js";
import { CLI_VERSION } from "../../utils/version.js";
import { EditFileTool } from "../tools/editFile.js";
import { FetchUrlTool } from "../tools/fetchUrl.js";
import { PresentPlanTool } from "../tools/presentPlan.js";
import { ReadFileTool } from "../tools/readFile.js";
import { ReadMemoryTool } from "../tools/readMemory.js";
import { ReadSkillTool } from "../tools/readSkill.js";
import { ReadTasksTool } from "../tools/readTasks.js";
import { RunCommandTool } from "../tools/runCommand.js";
import { SearchContentTool } from "../tools/searchContent.js";
import { SearchFilesTool } from "../tools/searchFiles.js";
import { TodoWriteTool } from "../tools/todoWrite.js";
import { WriteFileTool } from "../tools/writeFile.js";
import { WriteMemoryTool } from "../tools/writeMemory.js";
import { CLIMcpTransport } from "./cliTransport.js";

// Add local development tools to the MCP server
export const useFileSystemServer = async (
  dustAPI: DustAPI,
  onServerIdReceived: (serverId: string) => void,
  diffApprovalCallback?: (
    originalContent: string,
    updatedContent: string,
    filePath: string
  ) => Promise<boolean>,
  onRetry?: (attempt: number, maxAttempts: number, error: unknown) => void,
  // Omitted by non-interactive callers, which have no one to ask - see
  // PresentPlanTool for why it refuses rather than self-approving.
  planApprovalCallback?: (plan: string) => Promise<PlanDecision>
): Promise<Result<void, Error>> => {
  // Check if using API key authentication - MCP servers require OAuth
  const apiKey = await dustAPI.getApiKey();
  if (apiKey?.startsWith("sk-")) {
    return new Err(
      new Error(
        "File system access requires OAuth authentication. API keys don't support MCP server registration. Please use 'dustm login' to authenticate with OAuth for file system features."
      )
    );
  }

  const readFileTool = new ReadFileTool();
  const fetchUrlTool = new FetchUrlTool();
  const searchFilesTool = new SearchFilesTool();
  const searchContentTool = new SearchContentTool();
  const editFileTool = new EditFileTool();
  const writeFileTool = new WriteFileTool();
  const runCommandTool = new RunCommandTool();
  const todoWriteTool = new TodoWriteTool();
  const readTasksTool = new ReadTasksTool();
  const readMemoryTool = new ReadMemoryTool();
  const writeMemoryTool = new WriteMemoryTool();
  const readSkillTool = new ReadSkillTool();
  const presentPlanTool = new PresentPlanTool();

  if (planApprovalCallback) {
    presentPlanTool.setPlanApprovalCallback(planApprovalCallback);
  }

  if (diffApprovalCallback) {
    editFileTool.setDiffApprovalCallback(diffApprovalCallback);
    writeFileTool.setDiffApprovalCallback(diffApprovalCallback);
    // Memory writes land outside the repo (under ~/.claude), where a stray
    // write is less visible than one in the working tree - so they always
    // go through the same preview/approval prompt, and are deliberately not
    // pre-approved in toolsCache the way edit_file is.
    writeMemoryTool.setDiffApprovalCallback(diffApprovalCallback);
  }

  // The memory and skill tools are registered unconditionally, not gated on
  // /claude-code-mode: MCP tools are advertised once, when the server
  // connects at chat startup, so a mode toggled on later in the session
  // could not add them. What the mode actually changes is whether the agent
  // is *told* about the user's memories/Claude skills (the priming block /
  // skill catalogue) - the tools themselves are inert until it goes looking
  // for them. read_skill still finds dustm-directory skills (~/.dust-cli/
  // skills, ./.dust/skills) regardless of the mode; only the Claude-sourced
  // ones are gated.
  const tools = [
    readFileTool,
    fetchUrlTool,
    searchFilesTool,
    searchContentTool,
    editFileTool,
    writeFileTool,
    runCommandTool,
    todoWriteTool,
    readTasksTool,
    readMemoryTool,
    writeMemoryTool,
    readSkillTool,
    // Registered unconditionally, like the memory tools: MCP advertises its
    // tool list once at connect time, so a mode toggled on later in the
    // session could not add it. It reports plan mode being off rather than
    // doing anything when called outside it.
    presentPlanTool,
  ];

  // Transient connection failures shouldn't dead-end the user immediately -
  // retry with fresh server/transport instances a few times before giving
  // up (retrying server.connect() on the same instances after a failed
  // attempt isn't safe, since the transport may be left partially
  // connected).
  return retryResult(async () => {
    const server = new McpServer({
      name: "fs-cli",
      version: CLI_VERSION,
    });

    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema.shape,
        },
        tool.execute.bind(tool)
      );
    }

    const transport = new CLIMcpTransport(
      dustAPI,
      onServerIdReceived,
      "fs-cli"
    );

    try {
      await server.connect(transport);
      return new Ok(undefined);
    } catch (error) {
      console.error("[MCP Connection Failed]", error);
      return new Err(
        new Error(
          `Failed to connect MCP server: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
    }
  }, 5, 500, onRetry);
};
