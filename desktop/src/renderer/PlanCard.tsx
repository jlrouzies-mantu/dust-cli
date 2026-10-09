import { useRef, useState } from "react";

import type { TranscriptItem } from "../shared/ipc";
import { toast, useApp } from "./store";
import { Markdown } from "./Markdown";

type PlanItem = Extract<TranscriptItem, { kind: "plan" }>;

/** Splits a leading "# Title" off the plan and counts its list steps. */
function describePlan(markdown: string): {
  title: string;
  body: string;
  steps: number;
} {
  const lines = markdown.trim().split("\n");
  let title = "Proposed plan";
  let start = 0;
  const heading = lines[0]?.match(/^#{1,3}\s+(.*)$/);
  if (heading) {
    title = heading[1];
    start = 1;
  }
  const body = lines.slice(start).join("\n").trim();
  const steps = lines.filter((l) => /^(\d+\.|[-*])\s/.test(l)).length;
  return { title, body, steps };
}

const OUTCOME: Record<PlanItem["outcome"], string> = {
  pending: "",
  "approved-auto": "[ OK ] approved · implementing in »» auto-edit",
  "approved-wait": "[ OK ] approved · waiting for your next instruction",
  rejected: "[ -- ] rejected · still in plan mode",
};

export function PlanCard({ item }: { item: PlanItem }) {
  const { planId } = useApp();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const { title, body, steps } = describePlan(item.markdown);
  const active = item.outcome === "pending" && planId === item.id;

  const decide = async (
    choice:
      | { kind: "approve"; then: "auto" | "wait" }
      | { kind: "reject"; comment?: string }
  ) => {
    setBusy(true);
    const res = await window.dustm.resolvePlan(item.id, choice);
    if (!res.ok) {
      toast(res.error ?? "Could not send the decision.");
    }
    setBusy(false);
  };

  return (
    <article
      className={`plan-card ${active ? "" : "done"}`}
      aria-labelledby={`plan-${item.id}`}
    >
      <div className="band">
        <div className="shape" aria-hidden="true" />
        <div className="shape b" aria-hidden="true" />
        <div className="inner">
          <div className="eyebrow">
            present_plan{steps > 0 ? ` · ${steps} steps` : ""}
          </div>
          <h1 id={`plan-${item.id}`} ref={titleRef}>
            {title}
          </h1>
        </div>
      </div>
      <div className="plan-body agent-body">
        <Markdown text={body || item.markdown} />
      </div>
      {active ? (
        <div className="plan-foot">
          <div className="field">
            <label htmlFor={`plan-note-${item.id}`}>Or keep planning, with a note</label>
            <input
              id={`plan-note-${item.id}`}
              type="text"
              value={note}
              placeholder="e.g. start with a spike before extracting the core"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && note.trim()) {
                  void decide({ kind: "reject", comment: note });
                }
              }}
            />
          </div>
          <div className="btn-row">
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => decide({ kind: "approve", then: "auto" })}
            >
              Approve · »» auto-edit
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => decide({ kind: "approve", then: "wait" })}
            >
              Approve · wait for me
            </button>
            <span className="grow" />
            <button
              type="button"
              className="btn-quiet"
              disabled={busy}
              onClick={() => decide({ kind: "reject", comment: note || undefined })}
            >
              Keep planning
            </button>
          </div>
        </div>
      ) : item.outcome !== "pending" ? (
        <div
          className="plan-outcome"
          style={{ color: item.outcome === "rejected" ? "var(--err)" : "var(--ok)" }}
        >
          {OUTCOME[item.outcome]}
          {item.comment ? (
            <span style={{ color: "var(--muted)" }}> · “{item.comment}”</span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
