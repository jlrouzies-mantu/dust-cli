import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import type { VirtuosoHandle } from "react-virtuoso";

import type { TranscriptItem } from "../shared/ipc";
import { seconds } from "./format";
import { Markdown } from "./Markdown";
import { DiffLines } from "./Diff";
import { PlanCard } from "./PlanCard";

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{seconds(now - since)}</>;
}

const Row = memo(function Row({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="row">
          <div className="who-you">▌ you</div>
          <div className="user-text">{item.text}</div>
          {item.attachments?.length ? (
            <div className="user-attach">[+] {item.attachments.join(", ")}</div>
          ) : null}
        </div>
      );
    case "agent-header":
      return (
        <div className="row">
          <div className="who-agent">
            ▌ @{item.agentName}
            {item.detail ? <span className="detail"> · {item.detail}</span> : null}
          </div>
        </div>
      );
    case "agent-text":
      return (
        <div className="row" style={{ paddingTop: 10 }}>
          <div className="agent-body">
            <Markdown text={item.text} />
            {item.streaming ? <span className="caret" aria-hidden="true" /> : null}
          </div>
        </div>
      );
    case "tool": {
      const cls =
        item.status === "ok"
          ? "st-ok"
          : item.status === "running"
            ? "st-run"
            : item.status === "rejected"
              ? "st-rej"
              : "st-err";
      const mark =
        item.status === "ok"
          ? "[ OK ]"
          : item.status === "running"
            ? "[ .. ]"
            : item.status === "rejected"
              ? "[ -- ]"
              : "[ !! ]";
      return (
        <div className="row" style={{ paddingTop: 8 }}>
          <div className="tool" role="group" aria-label={`${item.name} ${item.status}`}>
            <span className={cls}>{mark}</span>
            <span className="nm">{item.name}</span>
            <span className="dt">{item.detail}</span>
            {item.status === "running" ? (
              <>
                <span className="dt">
                  · <Elapsed since={item.startedAt} />
                </span>
                <span className="esc">· Esc to stop</span>
              </>
            ) : item.status === "rejected" ? (
              <span className="dt">· rejected</span>
            ) : item.durationMs ? (
              <span className="dt">· {seconds(item.durationMs)}</span>
            ) : null}
          </div>
        </div>
      );
    }
    case "diff":
      return (
        <div className="row" style={{ paddingTop: 8 }}>
          <div className="diff-card">
            <div className="hd">
              <span className="st-ok" style={{ color: "var(--ok)" }}>[ OK ]</span>
              <span style={{ color: "#fff" }}>{item.tool}</span>
              <span className="path">{item.diff.path}</span>
              <span className="grow" />
              <span className="plus">+{item.diff.added}</span>
              <span className="minus">−{item.diff.removed}</span>
            </div>
            <DiffLines diff={item.diff} />
          </div>
        </div>
      );
    case "plan":
      return (
        <div className="row">
          <PlanCard item={item} />
        </div>
      );
    case "btw":
      return (
        <div className="row" style={{ paddingTop: 10 }}>
          <div className={`btw ${item.status}`}>
            <div className="hd">
              <span>BTW</span>
              <span className="q">{item.question}</span>
            </div>
            {item.status === "pending" ? (
              <div className="bd thinking">
                <span className="dot" aria-hidden="true" />
                Asking, apart from the conversation…
              </div>
            ) : (
              <div className="bd agent-body">
                {item.status === "error" ? (
                  <span style={{ color: "var(--err)" }}>{item.answer}</span>
                ) : (
                  <Markdown text={item.answer} />
                )}
              </div>
            )}
            <div className="ft">Not added to the conversation.</div>
          </div>
        </div>
      );
    case "note":
      return (
        <div className="row" style={{ paddingTop: 10 }}>
          <div className={`note ${item.tone}`} role={item.tone === "error" ? "alert" : undefined}>
            {item.text}
          </div>
        </div>
      );
  }
});

export interface TranscriptContext {
  busy: boolean;
  label: string | null;
  streaming: boolean;
  /** The turn has started but has nothing to show yet. */
  pendingAgent: { name: string; detail: string | null } | null;
  hasEarlier: boolean;
  loadingEarlier: boolean;
}

// One compact line while the agent has nothing to show: header and thinking
// indicator together, so there is never a tall empty block or an orphaned
// agent header.
function Footer({ context }: { context?: TranscriptContext }) {
  if (!context || !context.busy || context.streaming) {
    return <div style={{ height: 14 }} />;
  }
  return (
    <div className="col">
      <div className="thinking-row" role="status">
        {context.pendingAgent ? (
          <span className="who-agent">
            ▌ @{context.pendingAgent.name}
            {context.pendingAgent.detail ? (
              <span className="detail"> · {context.pendingAgent.detail}</span>
            ) : null}
          </span>
        ) : null}
        <span className="thinking" style={{ marginLeft: context.pendingAgent ? 12 : 14 }}>
          <span className="dot" aria-hidden="true" />
          {context.label ?? "Thinking"}…
        </span>
      </div>
    </div>
  );
}

function Header({ context }: { context?: TranscriptContext }) {
  return (
    <div className="col" style={{ paddingTop: 14 }}>
      {context?.hasEarlier ? (
        <button
          type="button"
          className="earlier"
          disabled={context.loadingEarlier}
          onClick={() => void window.dustm.loadEarlier()}
        >
          {context.loadingEarlier ? "Loading earlier messages…" : "↑ Load earlier messages"}
        </button>
      ) : null}
    </div>
  );
}

export function Transcript({
  items,
  firstItemIndex,
  context,
}: {
  items: TranscriptItem[];
  firstItemIndex: number;
  context: TranscriptContext;
}) {
  const ref = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  atBottomRef.current = atBottom;

  // followOutput only follows the last *item*; the "Thinking…" row lives in
  // the Footer, below it, so it stayed just out of view after a send. Scroll
  // to the true bottom (footer included) after layout: always when the user
  // has just sent a message, and when the footer appears or changes while the
  // view is already at the bottom.
  const lastItem = items[items.length - 1];
  const footerShown = context.busy && !context.streaming;
  const footerKey = footerShown ? `${context.pendingAgent?.name ?? ""}|${context.label ?? ""}` : "";
  const sentId = lastItem?.kind === "user" ? lastItem.id : null;
  useEffect(() => {
    if (!sentId) return;
    const raf = requestAnimationFrame(() =>
      ref.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" })
    );
    return () => cancelAnimationFrame(raf);
  }, [sentId]);
  useEffect(() => {
    if (!footerKey || !atBottomRef.current) return;
    const raf = requestAnimationFrame(() =>
      ref.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" })
    );
    return () => cancelAnimationFrame(raf);
  }, [footerKey]);

  const itemContent = useCallback(
    (_i: number, item: TranscriptItem) => (
      <div className="col">
        <Row item={item} />
      </div>
    ),
    []
  );

  return (
    <div className="transcript">
      <Virtuoso
        ref={ref}
        data={items}
        firstItemIndex={firstItemIndex}
        context={context}
        computeItemKey={(_i, item) => item.id}
        itemContent={itemContent}
        // Stick to the newest content while the user is at the bottom; stop
        // following the moment they scroll up to read.
        followOutput={(bottom) => (bottom ? "auto" : false)}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={80}
        initialTopMostItemIndex={items.length > 0 ? items.length - 1 : 0}
        increaseViewportBy={{ top: 600, bottom: 600 }}
        components={{ Header, Footer }}
        style={{ height: "100%" }}
        role="log"
        aria-label="Conversation"
        aria-live="off"
      />
      {!atBottom && items.length > 0 ? (
        <button
          type="button"
          className="jump"
          onClick={() =>
            ref.current?.scrollToIndex({
              index: "LAST",
              align: "end",
              behavior: "smooth",
            })
          }
        >
          ↓ Jump to latest
        </button>
      ) : null}
    </div>
  );
}
