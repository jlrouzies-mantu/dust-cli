import type { IpcMainInvokeEvent } from "electron";
import { BrowserWindow, app, dialog, ipcMain } from "electron";

import { normalizeError } from "../../../src/utils/errors";
import { MAX_FILE_SIZE } from "../../../src/utils/fileHandling";
import type {
  ApprovalDecision,
  AuthStatus,
  ChatMode,
  Effort,
  PlanChoice,
  Result,
  SessionState,
} from "../shared/ipc";
import {
  cancelSignIn,
  checkAuth,
  copyCode,
  getAuthStatus,
  openBrowser,
  openHttps,
  selectWorkspaceId,
  signOut,
  startSignIn,
} from "./auth";
import * as session from "./session";

/**
 * Every renderer-to-main call lands here. Two rules:
 *  - the sender must be our own window's top frame (a navigated-away or
 *    injected frame gets nothing);
 *  - every argument is validated as if it were hostile, because the renderer
 *    is the less trusted side of this boundary.
 */

let trustedWindow: BrowserWindow | null = null;
let trustedPrefix = "";
let cliFolder: string | null = null;
let cliAgent: string | null = null;

export function setTrusted(win: BrowserWindow, prefix: string): void {
  trustedWindow = win;
  trustedPrefix = prefix;
}

export function setCliFolder(dir: string | null): void {
  cliFolder = dir;
}

/** --agent=<sId>: for this run only; not remembered. */
export function setCliAgent(id: string | null): void {
  cliAgent = id;
}

function trusted(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    !!trustedWindow &&
    event.sender === trustedWindow.webContents &&
    !!frame &&
    frame === trustedWindow.webContents.mainFrame &&
    frame.url.startsWith(trustedPrefix)
  );
}

const DENIED: Result = { ok: false, error: "Untrusted caller." };

function handle<A extends unknown[], R>(
  channel: string,
  fn: (...args: A) => R | Promise<R>
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) {
      return DENIED;
    }
    try {
      return await fn(...(args as A));
    } catch (error) {
      return { ok: false, error: normalizeError(error).message } satisfies Result;
    }
  });
}

function isString(v: unknown, max = 200_000): v is string {
  return typeof v === "string" && v.length <= max;
}
const bad = (what: string): Result => ({ ok: false, error: `Invalid ${what}.` });

let checking: Promise<AuthStatus> | null = null;

export async function bootstrap(): Promise<{
  auth: AuthStatus;
  state: SessionState | null;
}> {
  if (getAuthStatus().kind === "checking") {
    checking ??= checkAuth().finally(() => {
      checking = null;
    });
    await checking;
  }
  if (getAuthStatus().kind === "ready") {
    await session.initSession();
    if (cliAgent && session.getState().agentId !== cliAgent) {
      session.selectAgent(cliAgent, false);
    }
    if (cliFolder && session.getState().folder !== cliFolder) {
      session.setFolder(cliFolder, false);
    }
  }
  const auth = getAuthStatus();
  return { auth, state: auth.kind === "ready" ? session.getState() : null };
}

export function registerIpc(): void {
  handle("dustm:bootstrap", () => bootstrap());

  handle("dustm:auth:start", () => startSignIn());
  handle("dustm:auth:cancel", () => cancelSignIn());
  handle("dustm:auth:open-browser", () => openBrowser());
  handle("dustm:auth:copy-code", () => copyCode());
  handle("dustm:auth:select-workspace", (id: unknown) =>
    isString(id, 200) ? selectWorkspaceId(id) : bad("workspace")
  );
  handle("dustm:auth:sign-out", () => signOut());

  handle("dustm:choose-folder", async (): Promise<Result<string | null>> => {
    if (!trustedWindow) {
      return { ok: false, error: "No window." };
    }
    const picked = await dialog.showOpenDialog(trustedWindow, {
      title: "Choose a working folder",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: session.getState().folder ?? undefined,
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: true, value: null };
    }
    const res = session.setFolder(picked.filePaths[0]);
    return res.ok ? { ok: true, value: picked.filePaths[0] } : { ok: false, error: res.error };
  });

  handle("dustm:list-conversations", () => session.listConversations());
  handle("dustm:load-conversation", (id: unknown) =>
    isString(id, 200) ? session.loadConversation(id) : bad("conversation")
  );
  handle("dustm:select-session", (key: unknown) =>
    isString(key, 100) ? session.selectSession(key) : bad("session")
  );
  handle("dustm:set-layout", (patch: unknown) =>
    patch && typeof patch === "object" ? session.setLayout(patch as Record<string, unknown>) : bad("layout")
  );
  handle("dustm:set-notify", (patch: unknown) =>
    patch && typeof patch === "object" ? session.setNotify(patch as Record<string, unknown>) : bad("notify")
  );
  handle("dustm:new-conversation", () => session.newConversation());
  handle("dustm:set-max-parallel", (n: unknown) =>
    typeof n === "number" ? session.setMaxParallel(n) : bad("number")
  );
  handle("dustm:load-earlier", () => session.loadEarlier());
  handle("dustm:select-agent", (id: unknown) =>
    isString(id, 200) ? session.selectAgent(id) : bad("agent")
  );

  handle("dustm:send", (text: unknown) =>
    isString(text) ? session.send(text) : bad("message")
  );
  handle("dustm:cancel", (source: unknown, sid: unknown) =>
    session.cancel(
      isString(source, 40) ? source : "unknown",
      isString(sid, 100) ? sid : null
    )
  );
  handle("dustm:recall-queued", () => session.recallQueued());

  handle("dustm:set-mode", (mode: unknown) =>
    mode === "normal" || mode === "auto" || mode === "plan"
      ? session.setMode(mode as ChatMode)
      : bad("mode")
  );
  handle("dustm:cycle-mode", () => session.cycleMode());

  handle("dustm:list-models", () => session.listModels());
  handle("dustm:set-model", (id: unknown) =>
    id === null || isString(id, 300) ? session.setModel(id) : bad("model")
  );
  handle("dustm:set-effort", (e: unknown) =>
    e === null || typeof e === "string"
      ? session.setEffort(e as Effort | null)
      : bad("effort")
  );

  handle("dustm:resolve-approval", (id: unknown, decision: unknown) => {
    const d = decision as ApprovalDecision | null;
    if (!isString(id, 100) || !d || typeof d !== "object") {
      return bad("approval");
    }
    const kinds = ["approve", "approve-all", "approve-remember", "reject"];
    if (!kinds.includes((d as { kind: string }).kind)) {
      return bad("approval");
    }
    const note =
      d.kind === "reject" && isString(d.note, 4000) ? d.note : undefined;
    return session.resolveApproval(
      id,
      d.kind === "reject" ? { kind: "reject", note } : { kind: d.kind }
    );
  });

  handle("dustm:resolve-plan", (id: unknown, choice: unknown) => {
    const c = choice as PlanChoice | null;
    if (!isString(id, 100) || !c || typeof c !== "object") {
      return bad("plan decision");
    }
    if (c.kind === "approve" && (c.then === "auto" || c.then === "wait")) {
      return session.resolvePlan(id, { kind: "approve", then: c.then });
    }
    if (c.kind === "reject") {
      return session.resolvePlan(id, {
        kind: "reject",
        comment: isString(c.comment, 4000) ? c.comment : undefined,
      });
    }
    return bad("plan decision");
  });

  const COMMANDS = ["compact", "btw", "loop", "skills", "claude-code-mode", "tasks", "clear-files"];
  handle("dustm:run-command", (name: unknown, args: unknown) =>
    isString(name, 40) && COMMANDS.includes(name) && isString(args, 20_000)
      ? session.runCommand(name, args)
      : bad("command")
  );
  handle("dustm:quit", () => {
    app.quit();
    return { ok: true } satisfies Result;
  });
  handle("dustm:mention-files", () => session.mentionFiles());
  handle("dustm:skills:list", () => session.listSkills());
  handle("dustm:skills:set-enabled", (names: unknown) =>
    Array.isArray(names) && names.length <= 2000 && names.every((n) => isString(n, 300))
      ? session.setSkillsEnabled(names as string[])
      : bad("skills")
  );

  // Attachments: main does all reading and uploading. The renderer only
  // names files the user chose (dialog here, or a drop) or hands over pasted
  // image bytes.
  handle("dustm:attach:pick-files", async (): Promise<Result> => {
    if (!trustedWindow) {
      return { ok: false, error: "No window." };
    }
    const picked = await dialog.showOpenDialog(trustedWindow, {
      title: "Attach files",
      properties: ["openFile", "multiSelections"],
      defaultPath: session.getState().folder ?? undefined,
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: true };
    }
    return session.attachPaths(picked.filePaths);
  });
  // Only reachable through the preload's attach.files, which derives the
  // paths from real dropped/pasted File objects; session.attachPaths still
  // re-checks each one (absolute, regular file, supported type, size).
  handle("dustm:attach:paths", (paths: unknown) =>
    Array.isArray(paths) && paths.length <= 20 && paths.every((p) => isString(p, 1000))
      ? session.attachPaths(paths as string[])
      : bad("paths")
  );
  handle("dustm:attach:image", (bytes: unknown, mime: unknown) =>
    bytes instanceof Uint8Array &&
    bytes.byteLength > 0 &&
    bytes.byteLength <= MAX_FILE_SIZE &&
    isString(mime, 40)
      ? session.attachImage(bytes, mime)
      : bad("image (empty, over 50 MB, or not an image)")
  );
  handle("dustm:attach:clipboard", () => session.attachClipboard());
  handle("dustm:attach:remove", (id: unknown) =>
    isString(id, 100) ? session.removeAttachment(id) : bad("attachment")
  );

  handle("dustm:open-external", (url: unknown) =>
    isString(url, 2000) ? openHttps(url) : bad("url")
  );
}
