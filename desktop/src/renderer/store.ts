import { useSyncExternalStore } from "react";

import { applyTranscriptEvent } from "../shared/transcript";
import { playSound } from "./sounds";
import type {
  ApprovalRequest,
  AuthStatus,
  ConversationSummary,
  SessionEvent,
  SessionState,
  TranscriptItem,
} from "../shared/ipc";

/**
 * A tiny external store: one immutable snapshot, replaced on every event.
 * Transcript updates replace a single array slot, so React only re-renders the
 * row that changed (rows are memoised by item identity).
 */
export interface AppSnapshot {
  booted: boolean;
  auth: AuthStatus;
  session: SessionState | null;
  items: TranscriptItem[];
  /** Virtuoso index of items[0]; decreases when older messages are prepended. */
  firstItemIndex: number;
  approval: { request: ApprovalRequest; pending: number } | null;
  planId: string | null;
  conversations: ConversationSummary[] | null;
  toast: { text: string; tone: "error" | "info" } | null;
}

const FIRST_INDEX = 1_000_000;

let snapshot: AppSnapshot = {
  booted: false,
  auth: { kind: "checking" },
  session: null,
  items: [],
  firstItemIndex: FIRST_INDEX,
  approval: null,
  planId: null,
  conversations: null,
  toast: null,
};

const listeners = new Set<() => void>();

function set(patch: Partial<AppSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const l of listeners) {
    l();
  }
}

export function getSnapshot(): AppSnapshot {
  return snapshot;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useApp(): AppSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function handleEvent(event: SessionEvent): void {
  // Main only sends the selected session's events, but one already in flight
  // when the user switched can still arrive: it belongs to a session that is
  // no longer on screen and must not render into this one.
  if (
    event.type !== "view" &&
    "sid" in event &&
    event.sid !== undefined &&
    snapshot.session &&
    event.sid !== snapshot.session.sessionKey
  ) {
    return;
  }
  switch (event.type) {
    case "auth":
      set({ auth: event.status });
      if (event.status.kind !== "ready") {
        set({ session: null, items: [], firstItemIndex: FIRST_INDEX, approval: null, planId: null });
      }
      return;
    case "state":
      set({ session: event.state });
      return;
    case "sessions":
      // Background sessions changed: badges and the running count only.
      if (snapshot.session) {
        set({ session: { ...snapshot.session, sessions: event.sessions, running: event.running } });
      }
      return;
    case "view":
      // Switching sessions: transcript, state, dialog and plan all at once.
      set({
        session: event.state,
        items: event.items,
        firstItemIndex: FIRST_INDEX,
        approval: event.approval,
        planId: event.planId,
      });
      return;
    case "transcript-reset":
      set({ items: event.items, firstItemIndex: FIRST_INDEX, planId: null });
      return;
    case "transcript-prepend":
      set({
        items: [...event.items, ...snapshot.items],
        firstItemIndex: snapshot.firstItemIndex - event.items.length,
      });
      return;
    case "append":
    case "text-delta":
    case "patch":
      // The same reducer main uses for the session's own list.
      set({ items: applyTranscriptEvent(snapshot.items, event) });
      return;
    case "approval":
      set({
        approval: event.request
          ? { request: event.request, pending: event.pending }
          : null,
      });
      return;
    case "plan-request":
      set({ planId: event.id });
      return;
    case "plan-clear":
      set({ planId: null });
      return;
    case "sound":
      void playSound(event.sound, event.volume);
      return;
    case "conversations-changed":
      void refreshConversations();
      return;
  }
}

export async function refreshConversations(): Promise<void> {
  if (snapshot.auth.kind !== "ready") {
    return;
  }
  const res = await window.dustm.listConversations();
  if (res.ok && res.value) {
    set({ conversations: res.value });
  }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(text: string, tone: "error" | "info" = "error"): void {
  set({ toast: { text, tone } });
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  toastTimer = setTimeout(() => set({ toast: null }), 6000);
}

/** Local-only transcript line (slash-command feedback). */
export function localNote(text: string, tone: "info" | "error" = "info"): void {
  set({
    items: [
      ...snapshot.items,
      { kind: "note", id: `local-${Date.now()}-${Math.random()}`, tone, text },
    ],
  });
}

// One event subscription for the life of the page. boot() runs from a
// useEffect, and React's StrictMode (dev builds) runs every effect twice:
// subscribing on each call registered two listeners, so every event was
// applied twice - each message, header and text delta showed up doubled in
// `npm run dev`, while the packaged build (no StrictMode double-run) and every
// smoke test looked fine.
let unsubscribe: (() => void) | null = null;

export async function boot(): Promise<void> {
  if (unsubscribe) {
    return;
  }
  unsubscribe = window.dustm.onEvent(handleEvent);
  // Read-only view of the transcript for the smoke harness, which cannot
  // count rendered rows (the list is virtualised, and the smoke window is
  // hidden, so nothing is laid out).
  (globalThis as Record<string, unknown>).__dustmItemKinds = () =>
    snapshot.items.map((i) => i.kind);
  // What is actually on screen for the selected session (smoke --smoke-multi).
  (globalThis as Record<string, unknown>).__dustmItemTexts = () =>
    snapshot.items.map((i) => (i.kind === "user" || i.kind === "agent-text" || i.kind === "note" ? i.text : ""));
  (globalThis as Record<string, unknown>).__dustmView = () => ({
    key: snapshot.session?.sessionKey ?? null,
    approval: snapshot.approval?.request.id ?? null,
    running: snapshot.session?.running ?? 0,
    title: document.title,
    statusbar: document.querySelector(".statusbar")?.textContent ?? "",
    sidebar: document.querySelector(".convo-list")?.textContent ?? "",
  });
  const { auth, state } = await window.dustm.bootstrap();
  set({ booted: true, auth, session: state });
  void refreshConversations();
}
