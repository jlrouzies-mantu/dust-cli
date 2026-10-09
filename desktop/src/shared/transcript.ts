import type { SessionEvent, TranscriptItem } from "./ipc";

/**
 * The one place that says how a transcript event changes a list of items.
 * Pure and Node-free, so main (which keeps every session's items, because a
 * background session must keep a transcript to show when it is opened) and the
 * renderer (which shows the selected one) apply events identically.
 */

/** The item being updated is almost always at or near the end. */
export function patchItem(
  items: TranscriptItem[],
  id: string,
  fn: (item: TranscriptItem) => TranscriptItem
): TranscriptItem[] {
  for (let i = items.length - 1; i >= 0 && i >= items.length - 400; i--) {
    if (items[i].id === id) {
      const next = items.slice();
      next[i] = fn(items[i]);
      return next;
    }
  }
  return items;
}

/** Returns the same array when the event does not concern the transcript. */
export function applyTranscriptEvent(
  items: TranscriptItem[],
  event: SessionEvent
): TranscriptItem[] {
  switch (event.type) {
    case "transcript-reset":
      return event.items;
    case "transcript-prepend":
      return [...event.items, ...items];
    case "append":
      return [...items, event.item];
    case "text-delta":
      return patchItem(items, event.id, (it) =>
        it.kind === "agent-text" ? { ...it, text: it.text + event.text } : it
      );
    case "patch":
      return patchItem(items, event.id, (it) => ({ ...it, ...event.patch }) as TranscriptItem);
    default:
      return items;
  }
}
