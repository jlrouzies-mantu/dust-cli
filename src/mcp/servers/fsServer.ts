import type { DustAPI, Result } from "@dust-tt/client";
import { Err, Ok } from "@dust-tt/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { retryResult } from "../../utils/retry.js";
import { CLI_VERSION } from "../../utils/version.js";
import { EditFileTool } from "../tools/editFile.js";
import { ReadFileTool } from "../tools/readFile.js";
import { RunCommandTool } from "../tools/runCommand.js";
import { SearchContentTool } from "../tools/searchContent.js";
import { SearchFilesTool } from "../tools/searchFiles.js";
import { CLIMcpTransport } from "./cliTransport.js";

// Add local development tools to the MCP server
export const useFileSystemServer = async (
  dustAPI: DustAPI,
  onServerIdReceived: (serverId: string) => void,
  diffApprovalCallback?: (
    originalContent: string,
    updatedContent: string,
    filePath: string
  ) => Promise<boolean>
): Promise<Result<void, Error>> => {
  // Check if using API key authentication - MCP servers require OAuth
  const apiKey = await dustAPI.getApiKey();
  if (apiKey?.startsWith("sk-")) {
    return new Err(
      new Error(
        "File system access requires OAuth authentication. API keys don't support MCP server registration. Please use 'dust login' to authenticate with OAuth for file system features."
      )
    );
  }

  const readFileTool = new ReadFileTool();
  const searchFilesTool = new SearchFilesTool();
  const searchContentTool = new SearchContentTool();
  const editFileTool = new EditFileTool();
  const runCommandTool = new RunCommandTool();

  if (diffApprovalCallback) {
    editFileTool.setDiffApprovalCallback(diffApprovalCallback);
  }

  const tools = [
    readFileTool,
    searchFilesTool,
    searchContentTool,
    editFileTool,
    runCommandTool,
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
  });
};
