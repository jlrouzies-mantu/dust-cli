import type { BrowserWindow, NotificationConstructorOptions } from "electron";
import { Notification, nativeImage } from "electron";

import type { NotifyChannel, NotifySettings } from "../shared/ipc";
import type { SoundId } from "../shared/sounds";
import { isSoundId } from "../shared/sounds";
import { emit } from "./bus";

/**
 * Desktop alerts for sessions that need you. Two independent channels per
 * event kind: a native pop-up and a sound. Policy lives in `shouldNotify` /
 * `mergeNotify` (pure); delivery goes through a sink so the smoke test can
 * record what would have been shown or played.
 *
 * Content rule: a toast carries the agent name, the conversation title and at
 * most ~80 characters of summary - never a message body.
 *
 * No double sound: the toast is ALWAYS created with `silent: true`. When a
 * sound is chosen the page plays it (a `sound` event; the window has
 * autoplayPolicy "no-user-gesture-required", and an HTMLAudioElement plays
 * while the window is hidden, minimised or unfocused); when "no sound" is
 * chosen the user wants none, so Windows' own default chime is wrong too.
 */

export type NotifyKind = "finished" | "approval" | "error";

export interface ToastSpec {
  /** Show a native pop-up. */
  popup: boolean;
  /** Tone to play, "none" for silence. */
  sound: SoundId;
  volume: number;
  title: string;
  body: string;
  kinds: NotifyKind[];
  /** Session to select when clicked (the first one, for a coalesced toast). */
  key: string;
}

export interface NotifyRequest {
  kind: NotifyKind;
  key: string;
  agentName: string;
  conversationTitle: string;
  /** Short hint: tool name, the start of the reply, the error text. */
  summary: string;
  /** This session is the one on screen. */
  selected: boolean;
}

export const DEFAULT_NOTIFY: NotifySettings = {
  enabled: true,
  volume: 0.7,
  finished: { popup: true, sound: "ping" },
  approval: { popup: true, sound: "two-tone" },
  error: { popup: true, sound: "chime" },
};

/** Coalescing window: a burst of events becomes one toast and one sound. */
export const COALESCE_MS = 700;
const SUMMARY_MAX = 80;
const TITLE_MAX = 60;
const KINDS: NotifyKind[] = ["finished", "approval", "error"];

/** Applies a (hostile-until-checked) patch onto settings. Pure. */
export function mergeNotify(base: NotifySettings, patch: unknown): NotifySettings {
  const p = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const next: NotifySettings = {
    enabled: typeof p.enabled === "boolean" ? p.enabled : base.enabled,
    volume:
      typeof p.volume === "number" && Number.isFinite(p.volume)
        ? Math.min(1, Math.max(0, p.volume))
        : base.volume,
    finished: { ...base.finished },
    approval: { ...base.approval },
    error: { ...base.error },
  };
  for (const kind of KINDS) {
    const c = p[kind];
    if (c && typeof c === "object") {
      const ch = c as Record<string, unknown>;
      const merged: NotifyChannel = { ...next[kind] };
      if (typeof ch.popup === "boolean") merged.popup = ch.popup;
      if (isSoundId(ch.sound)) merged.sound = ch.sound;
      next[kind] = merged;
    }
  }
  return next;
}

let win: BrowserWindow | null = null;
let activate: ((key: string) => void) | null = null;
let focusProbe: () => boolean = () => !!win && !win.isDestroyed() && win.isFocused();
let sink: (spec: ToastSpec) => void = deliver;
let pending: { req: NotifyRequest; channel: NotifyChannel; volume: number }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
const recent = new Map<string, number>();

export function setNotifyWindow(w: BrowserWindow): void {
  win = w;
  w.on("focus", () => {
    if (!w.isDestroyed()) w.flashFrame(false);
  });
}

/** Called with the session key when a toast is clicked (after focusing). */
export function setNotifyActivate(fn: (key: string) => void): void {
  activate = fn;
}

export function setNotifySinkForTest(next: ((spec: ToastSpec) => void) | null): void {
  sink = next ?? deliver;
}
export function setFocusProbeForTest(next: (() => boolean) | null): void {
  focusProbe = next ?? (() => !!win && !win.isDestroyed() && win.isFocused());
}
export function activateForTest(key: string): void {
  activate?.(key);
}

/**
 * The visible, focused conversation never notifies; a kind with neither a
 * pop-up nor a sound is off.
 */
export function shouldNotify(
  kind: NotifyKind,
  cfg: NotifySettings,
  selected: boolean,
  focused: boolean
): boolean {
  if (!cfg.enabled) return false;
  const ch = cfg[kind];
  if (!ch.popup && ch.sound === "none") return false;
  return !(selected && focused);
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function notifySession(req: NotifyRequest, cfg: NotifySettings): void {
  if (!shouldNotify(req.kind, cfg, req.selected, focusProbe())) return;
  // The same session and kind within a few seconds is the same event twice.
  const id = `${req.key}:${req.kind}`;
  const now = Date.now();
  if (now - (recent.get(id) ?? 0) < 3000) return;
  recent.set(id, now);
  pending.push({ req, channel: cfg[req.kind], volume: cfg.volume });
  if (req.kind === "approval" && win && !win.isDestroyed() && !focusProbe()) {
    win.flashFrame(true);
  }
  timer ??= setTimeout(flush, COALESCE_MS);
}

const PRIORITY: NotifyKind[] = ["approval", "error", "finished"];

function flush(): void {
  timer = null;
  const batch = pending;
  pending = [];
  if (batch.length === 0) return;
  const label = (k: NotifyKind) =>
    k === "approval" ? "needs you" : k === "error" ? "hit an error" : "finished";
  // One toast and one sound per burst: the pop-up if any member asked for it,
  // the sound of the most urgent member that asked for one.
  const popup = batch.some((b) => b.channel.popup);
  const sound: SoundId =
    PRIORITY.map((k) => batch.find((b) => b.req.kind === k && b.channel.sound !== "none")?.channel.sound).find(
      (s) => s !== undefined
    ) ?? "none";
  const volume = batch[0].volume;
  if (batch.length === 1) {
    const r = batch[0].req;
    sink({
      popup,
      sound,
      volume,
      title: `${clip(r.agentName, 40)} ${label(r.kind)}`,
      body: clip(`${clip(r.conversationTitle, TITLE_MAX)}${r.summary ? `: ${clip(r.summary, SUMMARY_MAX)}` : ""}`, 160),
      kinds: [r.kind],
      key: r.key,
    });
    return;
  }
  const reqs = batch.map((b) => b.req);
  const needs = reqs.filter((r) => r.kind === "approval").length;
  sink({
    popup,
    sound,
    volume,
    title: `${reqs.length} conversations need a look`,
    body: clip(
      `${needs > 0 ? `${needs} waiting for you. ` : ""}${reqs.map((r) => clip(r.conversationTitle, 24)).join(", ")}`,
      160
    ),
    kinds: reqs.map((r) => r.kind),
    key: reqs.find((r) => r.kind === "approval")?.key ?? reqs[0].key,
  });
}

/** The exact options a native toast is created with. Always silent. */
export function toastOptions(spec: ToastSpec): NotificationConstructorOptions {
  return { title: spec.title, body: spec.body, silent: true };
}

/** Default delivery: the pop-up (if wanted) and the page-played sound (if any). */
function deliver(spec: ToastSpec): void {
  if (spec.popup && Notification.isSupported()) {
    const n = new Notification(toastOptions(spec));
    n.on("click", () => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
      activate?.(spec.key);
    });
    n.show();
  }
  if (spec.sound !== "none") {
    emit({ type: "sound", sound: spec.sound, volume: spec.volume });
  }
}

// ------------------------------------------------------------ attention badge

let lastAttention = -1;
let lastNeeds = -1;

/**
 * Taskbar overlay for "N sessions need attention" (Windows). A plain dot:
 * the description carries the number for screen readers and the tooltip.
 */
export function setAttention(count: number, needsYou: number): void {
  if (count === lastAttention && needsYou === lastNeeds) return;
  lastAttention = count;
  lastNeeds = needsYou;
  if (process.platform !== "win32" || !win || win.isDestroyed()) return;
  if (count === 0) {
    win.setOverlayIcon(null, "");
    return;
  }
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const [r, g, b] = needsYou > 0 ? [0xf8, 0xf0, 0x60] : [0xe2, 0xc1, 0xff];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      const o = (y * size + x) * 4;
      if (d <= 7) {
        buf[o] = b;
        buf[o + 1] = g;
        buf[o + 2] = r;
        buf[o + 3] = 255;
      }
    }
  }
  win.setOverlayIcon(
    nativeImage.createFromBitmap(buf, { width: size, height: size }),
    `${count} session${count === 1 ? "" : "s"} need attention`
  );
}

export function notificationsSupported(): boolean {
  return Notification.isSupported();
}
