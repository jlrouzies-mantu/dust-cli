import { useEffect, useRef, useState } from "react";

import type { ConversationSummary, SessionState } from "../shared/ipc";
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
}: {
  session: SessionState;
  conversations: ConversationSummary[] | null;
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

  const open = async (id: string) => {
    if (id === session.conversationId) return;
    const res = await window.dustm.loadConversation(id);
    if (!res.ok) toast(res.error ?? "Could not open the conversation.");
  };

  const newChat = async () => {
    const res = await window.dustm.newConversation();
    if (!res.ok) toast(res.error ?? "Could not start a new conversation.");
  };

  const needle = search.trim().toLowerCase();
  const visible = (conversations ?? []).filter(
    (c) => !needle || c.title.toLowerCase().includes(needle)
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
        <div className="top">
          <Logo />
          <div className="who">
            {session.workspaceName ?? "Dust workspace"}
            <br />
            <b>{session.userName ?? ""}</b>
          </div>
        </div>
        <div className="tagline">
          <div className="y">Audacious ideas,</div>
          <div className="w">delivered beyond.</div>
        </div>
      </div>

      <div className="side-body">
        <button type="button" className="btn-primary" disabled={session.busy || !!session.compacting || !!opening} onClick={() => void newChat()}>
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
          {conversations === null ? (
            <div className="convo-group">loading…</div>
          ) : conversations.length === 0 ? (
            <div className="convo-group">no conversations yet</div>
          ) : visible.length === 0 ? (
            <div className="convo-group" role="status">no matches for “{search.trim()}”</div>
          ) : (
            groups.map((g) => (
              <div key={g.name} style={{ display: "contents" }}>
                <div className="convo-group">── {g.name}</div>
                {g.rows.map((c) => {
                  const active = c.sId === session.conversationId;
                  const isOpening = opening === c.sId;
                  return (
                    <button
                      key={c.sId}
                      type="button"
                      className="convo"
                      aria-current={active || isOpening}
                      aria-busy={isOpening}
                      disabled={(!!opening && !isOpening) || ((session.busy || !!session.compacting) && !active)}
                      onClick={() => void open(c.sId)}
                    >
                      <div className="t">{active && session.conversationTitle ? session.conversationTitle : c.title}</div>
                      <div className="m">
                        @{agentName}{" "}
                        {isOpening ? (
                          <span className="working"><span className="spinner small" aria-hidden="true" /> opening…</span>
                        ) : active && session.busy ? (
                          <span className="working">· working</span>
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

export function Aside({ session }: { session: SessionState }) {
  const ctx = session.usage.context;
  const cr = session.usage.credits;
  const ctxRatio = ctx && ctx.size > 0 ? (ctx.used / ctx.size) * 100 : 0;
  const crRatio = cr && cr.limit ? (cr.consumed / cr.limit) * 100 : 0;

  return (
    <aside className="aside" aria-label="Session">
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
