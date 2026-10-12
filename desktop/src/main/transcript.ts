import type { ConversationPublicType } from "@dust-tt/client";
import { structuredPatch } from "diff";
import { randomUUID } from "node:crypto";

import type { DiffLine, DiffPayload, TranscriptItem } from "../shared/ipc";

export function newId(): string {
  return randomUUID();
}

const MAX_DIFF_LINES = 1500;

/** A compact unified diff with 3 lines of context, shaped for the renderer. */
export function buildDiff(
  filePath: string,
  original: string,
  updated: string
): DiffPayload {
  const patch = structuredPatch(filePath, filePath, original, updated, "", "", {
    context: 3,
  });
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let truncated = false;
  let previousEnd = 1;

  for (const hunk of patch.hunks) {
    if (hunk.oldStart > previousEnd && lines.length > 0) {
      lines.push({ t: "gap", hidden: hunk.oldStart - previousEnd });
    }
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    for (const raw of hunk.lines) {
      if (raw.startsWith("\\")) {
        continue; // "\ No newline at end of file"
      }
      const text = raw.slice(1);
      if (raw.startsWith("+")) {
        added++;
        if (lines.length < MAX_DIFF_LINES) {
          lines.push({ t: "add", no: newNo, text });
        } else {
          truncated = true;
        }
        newNo++;
      } else if (raw.startsWith("-")) {
        removed++;
        if (lines.length < MAX_DIFF_LINES) {
          lines.push({ t: "del", no: oldNo, text });
        } else {
          truncated = true;
        }
        oldNo++;
      } else {
        if (lines.length < MAX_DIFF_LINES) {
          lines.push({ t: "ctx", no: newNo, text });
        } else {
          truncated = true;
        }
        oldNo++;
        newNo++;
      }
    }
    previousEnd = hunk.oldStart + hunk.oldLines;
  }

  return { path: filePath, added, removed, lines, truncated };
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One short line describing a tool call, for the "[ OK ] name detail" row. */
export function describeToolCall(
  name: string,
  params: Record<string, unknown>
): string {
  const str = (key: string): string | null =>
    typeof params[key] === "string" ? (params[key] as string) : null;

  switch (name) {
    case "read_file": {
      const p = str("path") ?? "";
      const offset = params["offset"];
      const limit = params["limit"];
      return typeof offset === "number" && typeof limit === "number"
        ? `${p} · ${offset}–${offset + limit}`
        : p;
    }
    case "write_file":
    case "edit_file":
      return str("path") ?? "";
    case "run_command": {
      const args = Array.isArray(params["args"])
        ? (params["args"] as unknown[]).map(String).join(" ")
        : "";
      return clip(`${str("command") ?? ""} ${args}`, 140);
    }
    case "search_content":
      return clip(
        `"${str("pattern") ?? ""}"${str("path") ? ` in ${str("path")}` : ""}`,
        140
      );
    case "search_files":
      return clip(`${str("pattern") ?? ""}`, 140);
    case "fetch_url":
      return str("url") ?? "";
    case "todo_write": {
      const todos = params["todos"];
      return Array.isArray(todos) ? `${todos.length} tasks` : "";
    }
    default: {
      const json = JSON.stringify(params);
      return json && json !== "{}" ? clip(json, 120) : "";
    }
  }
}

/** Past conversation to transcript items (what the CLI's resume does). */
export function itemsFromConversation(
  conversation: ConversationPublicType,
  agentName: string
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const group of conversation.content) {
    for (const msg of group) {
      if (msg.type === "user_message") {
        items.push({ kind: "user", id: newId(), text: msg.content });
      } else if (msg.type === "agent_message") {
        items.push({
          kind: "agent-header",
          id: newId(),
          agentName: msg.configuration?.name ?? agentName,
          detail: null,
        });
        for (const action of msg.actions ?? []) {
          const params = (action.params ?? {}) as Record<string, unknown>;
          items.push({
            kind: "tool",
            id: newId(),
            name: action.toolName,
            detail: describeToolCall(action.toolName, params),
            status: action.status === "errored" ? "error" : "ok",
            startedAt: 0,
            durationMs: action.executionDurationMs ?? null,
          });
        }
        if (msg.content) {
          items.push({
            kind: "agent-text",
            id: newId(),
            text: msg.content.trim(),
            streaming: false,
          });
        }
      }
    }
  }
  return items;
}
