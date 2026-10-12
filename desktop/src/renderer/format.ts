export function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function percent(used: number, total: number): number {
  return total > 0 ? Math.round((used / total) * 100) : 0;
}

/** C:\Users\me\x -> ~\x, /home/me/x -> ~/x (display only). */
export function shortPath(p: string | null): string {
  if (!p) {
    return "no folder";
  }
  return p
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~")
    .replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

export function relativeDay(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  const startToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  ).getTime();
  if (ms >= startToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (ms >= startToday - 6 * 86_400_000) {
    return d.toLocaleDateString([], { weekday: "short" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export type Bucket = "today" | "this week" | "earlier";

export function bucketOf(ms: number, now = Date.now()): Bucket {
  const today = new Date(now);
  const startToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  ).getTime();
  if (ms >= startToday) return "today";
  if (ms >= startToday - 6 * 86_400_000) return "this week";
  return "earlier";
}

/** 4-step bar for a context window: 250k reads ▮▮▮▯, 1M ▮▮▮▮. */
export function contextBar(size: number | null): string {
  if (!size) return "";
  const n = size < 100_000 ? 1 : size < 200_000 ? 2 : size <= 400_000 ? 3 : 4;
  return "▮".repeat(n) + "▯".repeat(4 - n);
}

export function seconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
