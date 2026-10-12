import { useEffect, useRef, useState } from "react";

import type { ConversationSummary, SessionBadge, SessionState } from "../shared/ipc";
import { contextUsageColor, creditsUsageColor } from "../../../src/utils/brand";
import { chatModeColor, chatModeLabel } from "../../../src/utils/chatMode";
import {
  PLAN_MODE_ALLOWED_TOOLS,
  PLAN_MODE_BLOCKED_TOOLS,
} from "../../../src/utils/planMode";
import { bucketOf, compact, percent, relativeDay, shortPath } from "./format";
import { Logo } from "./Logo";
import { toast } from "./store";

// ------------------------------------------------------------ sidebar

export function Sidebar({
  session,
  conversations,
  onCollapse,
  onSettings,
}: {
  session: SessionState;
  conversations: ConversationSummary[] | null;
  onCollapse: () => void;
  onSettings: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [search, setSearch] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(false);
        // Back to the message box, like every other popover.
        document.getElementById("composer")?.focus();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Switching never waits: a conversation that is still opening is superseded
  // by the next click, and a running one keeps going in the background.
  const open = async (id: string) => {
    if (id === session.conversationId && !session.loadingConversationId) return;
    const res = await window.dustm.loadConversation(id);
    if (!res.ok) toast(res.error ?? "Could not open the conversation.");
  };

  const openSession = async (key: string) => {
    if (key === session.sessionKey && !session.loadingConversationId) return;
    const res = await window.dustm.selectSession(key);
    if (!res.ok) toast(res.error ?? "Could not open the session.");
  };

  const newChat = async () => {
    const res = await window.dustm.newConversation();
    if (!res.ok) toast(res.error ?? "Could not start a new conversation.");
  };

  const needle = search.trim().toLowerCase();
  // Sessions that are doing something (or have something for you) sit in an
  // "Active" group; the same conversation is not repeated in the list below.
  const activeSessions = session.sessions.filter((x) => x.status !== "idle");
  const activeIds = new Set(activeSessions.map((x) => x.conversationId).filter(Boolean));
  const statusByConversation = new Map(
    session.sessions.filter((x) => x.conversationId).map((x) => [x.conversationId as string, x])
  );
  const visible = (conversations ?? []).filter(
    (c) => !activeIds.has(c.sId) && (!needle || c.title.toLowerCase().includes(needle))
  );
  const visibleActive = activeSessions.filter(
    (x) => !needle || x.title.toLowerCase().includes(needle)
  );
  const opening = session.loadingConversationId;
  const groups: { name: string; rows: ConversationSummary[] }[] = [];
  for (const c of visible) {
    const name = bucketOf(c.updated);
    let g = groups.find((x) => x.name === name);
    if (!g) {
      g = { name, rows: [] };
      groups.push(g);
    }
    g.rows.push(c);
  }
  const agentName = session.agents.find((a) => a.sId === session.agentId)?.name ?? "dust";

  return (
    <nav className="sidebar" aria-label="Conversations">
      <div className="brand">
        <div className="shape s1" aria-hidden="true" />
        <div className="shape s2" aria-hidden="true" />
        <div className="shape s3" aria-hidden="true" />
        <button
          type="button"
          className="panel-toggle"
          aria-label="Collapse conversations panel (Ctrl+B)"
          title="Collapse (Ctrl+B)"
          onClick={onCollapse}
        >
          ‹
        </button>
        <div className="top">
          <Logo />
          <div className="who">
            {session.workspaceName ?? "Dust workspace"}
            <br />
            {session.userName ? (
              <span className="author" title={session.userName}>
                author: {session.userName}
              </span>
            ) : null}
          </div>
        </div>
        <div className="tagline">
          <div className="y">Audacious ideas,</div>
          <div className="w">delivered beyond.</div>
        </div>
      </div>

      <div className="side-body">
        <button type="button" className="btn-primary" onClick={() => void newChat()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New chat
        </button>

        <div className="search">
          <label htmlFor="convo-search" className="sr-only">Search conversations</label>
          <input
            id="convo-search"
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Search conversations"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && search) {
                e.preventDefault();
                e.stopPropagation();
                setSearch("");
              }
            }}
          />
        </div>

        <div className="convo-list" aria-busy={!!opening}>
          {visibleActive.length > 0 ? (
            <div style={{ display: "contents" }}>
              <div className="convo-group">── Active</div>
              {visibleActive.map((x) => (
                <SessionRow
                  key={x.key}
                  badge={x}
                  agentName={agentName}
                  onOpen={() => void openSession(x.key)}
                />
              ))}
            </div>
          ) : null}
          {conversations === null ? (
            <div className="convo-group">loading…</div>
          ) : conversations.length === 0 && visibleActive.length === 0 ? (
            <div className="convo-group">no conversations yet</div>
          ) : visible.length === 0 && visibleActive.length === 0 ? (
            <div className="convo-group" role="status">no matches for “{search.trim()}”</div>
          ) : (
            groups.map((g) => (
              <div key={g.name} style={{ display: "contents" }}>
                <div className="convo-group">── {g.name}</div>
                {g.rows.map((c) => {
                  const active = c.sId === session.conversationId;
                  const isOpening = opening === c.sId;
                  const live = statusByConversation.get(c.sId);
                  return (
                    <button
                      key={c.sId}
                      type="button"
                      className="convo"
                      aria-current={active || isOpening}
                      aria-busy={isOpening}
                      onClick={() => void open(c.sId)}
                    >
                      <div className="t">{active && session.conversationTitle ? session.conversationTitle : c.title}</div>
                      <div className="m">
                        @{agentName}{" "}
                        {isOpening ? (
                          <span className="working"><span className="spinner small" aria-hidden="true" /> opening…</span>
                        ) : live && live.status !== "idle" ? (
                          <StatusBadge status={live.status} />
                        ) : (
                          <>· {relativeDay(c.updated)}</>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="side-foot" ref={menuRef}>
          {menu ? (
            <div className="user-menu" role="menu" aria-label="Account">
              <button
                type="button"
                role="menuitem"
                autoFocus
                onClick={() => {
                  setMenu(false);
                  onSettings();
                }}
              >
                Settings
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  void window.dustm.auth.signOut();
                }}
              >
                Sign out
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="user-btn"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
          >
            <span>{session.userName ?? "Account"}</span>
            <span aria-hidden="true">▴</span>
          </button>
          <button
            type="button"
            className="bug"
            onClick={() => void window.dustm.openExternal("https://github.com/jlrouzies-mantu/dust-cli")}
          >
            Report a bug ↗
          </button>
        </div>
      </div>
    </nav>
  );
}

function StatusBadge({ status }: { status: SessionBadge["status"] }) {
  switch (status) {
    case "running":
      return (
        <span className="sbadge running">
          <span aria-hidden="true">[ .. ]</span>
          <span className="sr-only">running</span>
        </span>
      );
    case "waiting-slot":
      return (
        <span className="sbadge waiting">
          <span aria-hidden="true">[ zz ]</span> waiting for a free slot
        </span>
      );
    case "approval":
      return (
        <span className="sbadge approval">
          <span className="sdot" aria-hidden="true" /> needs you
        </span>
      );
    case "finished":
      return (
        <span className="sbadge finished">
          <span className="sdot" aria-hidden="true" /> finished
        </span>
      );
    case "error":
      return (
        <span className="sbadge error">
          <span className="sdot" aria-hidden="true" /> error
        </span>
      );
    default:
      return null;
  }
}

function SessionRow({
  badge,
  agentName,
  onOpen,
}: {
  badge: SessionBadge;
  agentName: string;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="convo" aria-current={badge.selected} onClick={onOpen}>
      <div className="t">{badge.title}</div>
      <div className="m">
        @{agentName} <StatusBadge status={badge.status} />
      </div>
    </button>
  );
}

// ------------------------------------------------------------ aside

function Meter({ ratio, color, dots }: { ratio: number; color: string; dots?: boolean }) {
  const filled = Math.max(0, Math.min(10, Math.round(ratio / 10)));
  const full = dots ? "●" : "█";
  return (
    <div className={`meter ${dots ? "dots" : ""}`} aria-hidden="true">
      <span style={{ color }}>{full.repeat(filled)}</span>
      <span className="off">{full.repeat(10 - filled)}</span>
    </div>
  );
}

export function creditsText(c: NonNullable<SessionState["usage"]["credits"]>): string {
  const limit = c.limit !== null ? `/${compact(c.limit)} (${percent(c.consumed, c.limit)}%)` : "";
  return `${compact(c.consumed)}${limit} credits used`;
}

export function contextText(x: NonNullable<SessionState["usage"]["context"]>): string {
  return `${compact(x.used)}/${compact(x.size)} tokens`;
}

export function Aside({ session, onCollapse }: { session: SessionState; onCollapse: () => void }) {
  const ctx = session.usage.context;
  const cr = session.usage.credits;
  const ctxRatio = ctx && ctx.size > 0 ? (ctx.used / ctx.size) * 100 : 0;
  const crRatio = cr && cr.limit ? (cr.consumed / cr.limit) * 100 : 0;

  return (
    <aside className="aside" aria-label="Session">
      <button
        type="button"
        className="panel-toggle right"
        aria-label="Collapse session panel (Ctrl+Alt+B)"
        title="Collapse (Ctrl+Alt+B)"
        onClick={onCollapse}
      >
        ›
      </button>
      {session.mode === "plan" ? (
        <>
          <section className="card teal">
            <h2>Allowed while planning</h2>
            <div className="mono-list">
              {PLAN_MODE_ALLOWED_TOOLS.map((t) => (
                <div key={t}>
                  <span style={{ color: "var(--ok)" }}>[ OK ]</span> {t}
                </div>
              ))}
            </div>
          </section>
          <section className="card red">
            <h2>Blocked until you approve</h2>
            <div className="mono-list blocked">
              {PLAN_MODE_BLOCKED_TOOLS.map((t) => (
                <div key={t}>
                  <span style={{ color: "var(--err)" }}>[ -- ]</span> {t}
                </div>
              ))}
            </div>
          </section>
          <p className="plain-note">
            Only your approval leaves plan mode. <kbd>Shift+Tab</kbd> cycles □ normal → »» auto-edit → ■ plan.
          </p>
        </>
      ) : null}

      <section className="card" aria-label="Tasks">
        <h2>Tasks</h2>
        {session.tasks.length === 0 ? (
          <div className="plain-note">No tasks yet. The agent adds them when it plans multi-step work.</div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 9 }}>
            {session.tasks.map((t) => (
              <li
                key={t.id}
                className={`task ${t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : ""}`}
              >
                <span className="mk" aria-hidden="true">
                  {t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]"}
                </span>
                <span className="sr-only">{t.status.replace("_", " ")}: </span>
                <span className="tx">{t.content}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section" aria-label="Context">
        <h2>Context</h2>
        {ctx ? (
          <>
            <Meter ratio={ctxRatio} color={ctxRatio >= 50 ? contextUsageColor(ctxRatio) : "var(--tokens)"} />
            <div className="meter-label" style={{ color: "var(--tokens)" }}>
              {contextText(ctx)} <span className="m">· {percent(ctx.used, ctx.size)}%</span>
            </div>
          </>
        ) : (
          <div className="meter-label m" style={{ color: "var(--muted)" }}>
            Appears after the first reply.
          </div>
        )}
        <button
          type="button"
          className="small-btn"
          disabled={!session.conversationId || session.busy || !!session.compacting}
          title="Summarize this conversation to free up context window"
          onClick={() => void window.dustm.runCommand("compact", "")}
        >
          /compact now
        </button>
      </section>

      <section className="section" aria-label="Credits">
        <h2>Credits</h2>
        {cr ? (
          <>
            {cr.limit ? <Meter dots ratio={crRatio} color={creditsUsageColor(crRatio)} /> : null}
            <div className="meter-label" style={{ color: "var(--gold)" }}>{creditsText(cr)}</div>
          </>
        ) : (
          <div className="meter-label" style={{ color: "var(--muted)" }}>Not available.</div>
        )}
      </section>

      <section className="section" aria-label="Side question">
        <h2>Side question</h2>
        <button
          type="button"
          className="dashed-btn"
          title="Ask a side question; it is never added to the conversation"
          onClick={() => window.dispatchEvent(new CustomEvent("dustm:prefill", { detail: "/btw " }))}
        >
          /btw ask without interrupting…
        </button>
      </section>
    </aside>
  );
}

// ------------------------------------------------------------ status bar

export function StatusBar({ session }: { session: SessionState }) {
  const agent = session.agents.find((a) => a.sId === session.agentId);
  const ctx = session.usage.context;
  const cr = session.usage.credits;
  const sep = <span aria-hidden="true">·</span>;
  return (
    <footer className="statusbar" aria-label="Status">
      <span style={{ color: "var(--purple)" }}>{session.workspaceName ?? "Dust"}</span>
      {sep}
      <span style={{ color: "var(--agent)" }}>@{agent?.name ?? "agent"}</span>
      {sep}
      <span style={{ color: "var(--user)" }} title={session.folder ?? undefined}>
        {shortPath(session.folder)}
      </span>
      {session.branch ? (
        <>
          {sep}
          <span style={{ color: "var(--mint)" }}>{session.branch}</span>
        </>
      ) : null}
      {sep}
      <span style={{ color: chatModeColor(session.mode) }}>{chatModeLabel(session.mode)}</span>
      {session.running > 0 ? (
        <>
          {sep}
          <span
            className="sbadge running"
            role="status"
            title={`${session.running} turn(s) running, up to ${session.maxParallel} at once`}
          >
            {session.running} running
            {session.running >= session.maxParallel ? ` (max ${session.maxParallel})` : ""}
          </span>
        </>
      ) : null}
      {session.conversationId ? (
        <>
          {sep}
          <span>{session.conversationId}</span>
        </>
      ) : null}
      {ctx ? (
        <>
          {sep}
          <span style={{ color: "var(--tokens)" }}>{contextText(ctx)}</span>
        </>
      ) : null}
      {cr ? (
        <>
          {sep}
          <span style={{ color: "var(--gold)" }}>{creditsText(cr)}</span>
        </>
      ) : null}
    </footer>
  );
}

// ------------------------------------------------------------ rails & resize

/** The left panel collapsed: an expand button and the background-session counts. */
export function LeftRail({ session, onExpand }: { session: SessionState; onExpand: () => void }) {
  const count = (st: string) => session.sessions.filter((x) => x.status === st).length;
  const needs = count("approval");
  const done = count("finished");
  const err = count("error");
  const running = session.running;
  const summary = [
    needs ? `${needs} waiting for you` : "",
    done ? `${done} finished` : "",
    err ? `${err} with errors` : "",
    running ? `${running} running` : "",
  ].filter(Boolean).join(", ");
  return (
    <nav className="rail" aria-label="Conversations (collapsed)">
      <button
        type="button"
        className="panel-toggle static"
        aria-label={`Expand conversations panel (Ctrl+B)${summary ? `. ${summary}` : ""}`}
        title="Expand (Ctrl+B)"
        onClick={onExpand}
      >
        ›
      </button>
      {needs > 0 ? <span className="rail-badge approval" title={`${needs} waiting for you`}>{needs}</span> : null}
      {err > 0 ? <span className="rail-badge error" title={`${err} with errors`}>{err}</span> : null}
      {done > 0 ? <span className="rail-badge finished" title={`${done} finished`}>{done}</span> : null}
      {running > 0 ? <span className="rail-badge running" title={`${running} running`}>{running}</span> : null}
    </nav>
  );
}

export function RightRail({ onExpand }: { onExpand: () => void }) {
  return (
    <aside className="rail right" aria-label="Session (collapsed)">
      <button
        type="button"
        className="panel-toggle static"
        aria-label="Expand session panel (Ctrl+Alt+B)"
        title="Expand (Ctrl+Alt+B)"
        onClick={onExpand}
      >
        ‹
      </button>
    </aside>
  );
}

/** Drag (or arrow keys) to resize a side panel; the centre column stays fluid. */
export function PanelResizer({
  side,
  width,
  min,
  max,
  onChange,
  onCommit,
}: {
  side: "left" | "right";
  width: number;
  min: number;
  max: number;
  onChange: (w: number) => void;
  onCommit: (w: number) => void;
}) {
  const clamp = (w: number) => Math.min(max, Math.max(min, Math.round(w)));
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = width;
    let last = start;
    const move = (ev: PointerEvent) => {
      last = clamp(start + (side === "left" ? ev.clientX - startX : startX - ev.clientX));
      onChange(last);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      onCommit(last);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return (
    <div
      className={`resizer ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? "Resize conversations panel" : "Resize session panel"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onCommit(clamp(side === "left" ? 280 : 290))}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 12;
        const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        const next = clamp(width + (side === "left" ? dir : -dir) * step);
        onChange(next);
        onCommit(next);
      }}
    />
  );
}
