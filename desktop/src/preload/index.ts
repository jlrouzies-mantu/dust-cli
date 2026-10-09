import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { DustmApi, SessionEvent } from "../shared/ipc";

/**
 * The renderer's whole view of the outside world. Each method is one named
 * IPC channel; nothing here exposes ipcRenderer, Node, a file path chooser
 * of its own, or a token.
 */
const call = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(`dustm:${channel}`, ...args) as Promise<T>;

// Electron removed File.path; webUtils is the sanctioned way to learn a
// dropped file's path. Anything that is not a real File (it throws) or a File
// built by script (no path) yields "".
function pathOf(file: unknown): string {
  try {
    return webUtils.getPathForFile(file as File) || "";
  } catch {
    return "";
  }
}

const api: DustmApi = {
  bootstrap: () => call("bootstrap"),
  auth: {
    start: () => call("auth:start"),
    cancel: () => call("auth:cancel"),
    openBrowser: () => call("auth:open-browser"),
    copyCode: () => call("auth:copy-code"),
    selectWorkspace: (id) => call("auth:select-workspace", id),
    signOut: () => call("auth:sign-out"),
  },
  chooseFolder: () => call("choose-folder"),
  listConversations: () => call("list-conversations"),
  loadConversation: (id) => call("load-conversation", id),
  newConversation: () => call("new-conversation"),
  loadEarlier: () => call("load-earlier"),
  selectAgent: (id) => call("select-agent", id),
  send: (text) => call("send", text),
  cancel: () => call("cancel"),
  recallQueued: () => call("recall-queued"),
  setMode: (mode) => call("set-mode", mode),
  cycleMode: () => call("cycle-mode"),
  listModels: () => call("list-models"),
  setModel: (id) => call("set-model", id),
  setEffort: (effort) => call("set-effort", effort),
  resolveApproval: (id, decision) => call("resolve-approval", id, decision),
  resolvePlan: (id, choice) => call("resolve-plan", id, choice),
  openExternal: (url) => call("open-external", url),
  runCommand: (name, args) => call("run-command", name, args),
  quit: () => call("quit"),
  mentionFiles: () => call("mention-files"),
  skills: {
    list: () => call("skills:list"),
    setEnabled: (names) => call("skills:set-enabled", names),
  },
  attach: {
    pickFiles: () => call("attach:pick-files"),
    // Paths are derived here, from File objects, and never accepted as
    // strings from the page: a File built by script (new File(...)) has no
    // path, so only a real drop or paste can name a file on disk. Main
    // re-checks each one (absolute, a regular file, supported, size).
    files: async (files) => {
      const paths: string[] = [];
      let withoutPath = 0;
      for (const file of Array.from(files ?? []).slice(0, 20)) {
        const p = pathOf(file);
        if (p) paths.push(p);
        else withoutPath++;
      }
      if (paths.length > 0) {
        const res = await call<{ ok: boolean; error?: string }>("attach:paths", paths);
        if (!res.ok) return res;
      }
      return { ok: true, value: withoutPath };
    },
    image: (bytes, mime) => call("attach:image", bytes, mime),
    clipboard: () => call("attach:clipboard"),
    remove: (id) => call("attach:remove", id),
  },
  hasPath: (file) => pathOf(file) !== "",
  onEvent: (listener) => {
    const handler = (_e: unknown, event: SessionEvent) => listener(event);
    ipcRenderer.on("dustm:event", handler);
    return () => {
      ipcRenderer.removeListener("dustm:event", handler);
    };
  },
};

contextBridge.exposeInMainWorld("dustm", api);
