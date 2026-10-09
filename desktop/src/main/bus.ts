import type { SessionEvent } from "../shared/ipc";

/**
 * One-way channel from the main-process modules to whichever window is
 * listening. Kept separate from Electron so auth.ts and session.ts can be
 * driven (and smoke-tested) without a window.
 */
type Listener = (event: SessionEvent) => void;

const listeners = new Set<Listener>();

export function onSessionEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emit(event: SessionEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}
