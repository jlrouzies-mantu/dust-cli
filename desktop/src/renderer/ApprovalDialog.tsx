import { useState } from "react";

import type { ApprovalDecision, ApprovalRequest } from "../shared/ipc";
import { DiffLines } from "./Diff";
import { Modal } from "./Modal";
import { shortPath } from "./format";
import { toast } from "./store";

export function ApprovalDialog({
  request,
  pending,
}: {
  request: ApprovalRequest;
  pending: number;
}) {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);

  const decide = async (decision: ApprovalDecision) => {
    if (sending) {
      return;
    }
    setSending(true);
    const res = await window.dustm.resolveApproval(request.id, decision);
    if (!res.ok) {
      toast(res.error ?? "Could not send the decision.");
    }
    setSending(false);
  };
  const reject = () =>
    decide({ kind: "reject", note: note.trim() || undefined });

  const isEdit = request.type === "edit";
  const tool = request.tool.toUpperCase();

  return (
    <Modal
      labelledBy="approve-title"
      onEscape={() => void reject()}
      initialFocus="[data-approve]"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          void reject();
        } else if (
          e.key === "Enter" &&
          !e.shiftKey &&
          e.target instanceof HTMLElement &&
          e.target.tagName !== "BUTTON" &&
          e.target.tagName !== "TEXTAREA"
        ) {
          // Enter in the note box rejects with that note (it is a rejection
          // note); anywhere else Enter approves.
          e.preventDefault();
          if (e.target.tagName === "INPUT") {
            if (note.trim()) {
              void reject();
            }
          } else {
            void decide({ kind: "approve" });
          }
        }
      }}
    >
      <div className="band">
        <div className="shape" aria-hidden="true" />
        <div className="inner">
          <div className="eyebrow">
            {tool} · needs your ok{pending > 1 ? ` · ${pending} waiting` : ""}
          </div>
          <h1 id="approve-title">
            {isEdit ? "@dust wants to change a file" : "@dust wants to run a tool"}
          </h1>
          {request.type === "edit" ? (
            <div className="sub">
              {request.diff.path}{" "}
              <span className="plus">+{request.diff.added}</span>{" "}
              <span className="minus">−{request.diff.removed}</span>
            </div>
          ) : (
            <div className="sub">stake: {request.stake}</div>
          )}
        </div>
      </div>

      {request.type === "edit" ? (
        <div className="diff-wrap" tabIndex={0} aria-label="Diff, scrollable">
          <DiffLines diff={request.diff} />
        </div>
      ) : (
        <pre className="args" tabIndex={0} aria-label="Tool arguments, scrollable">
          {request.inputs}
        </pre>
      )}

      <div className="foot">
        <div className="field">
          <label htmlFor="approval-note">
            {isEdit
              ? "Reject with a note for @dust (optional)"
              : "Reject (optional note is not sent for tool calls)"}
          </label>
          <input
            id="approval-note"
            type="text"
            value={note}
            disabled={!isEdit}
            placeholder="e.g. keep the catalogue sorted by context size"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn-primary"
            data-approve
            disabled={sending}
            onClick={() => decide({ kind: "approve" })}
          >
            Approve <kbd>Enter</kbd>
          </button>
          {isEdit ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={sending}
              onClick={() => decide({ kind: "approve-all" })}
            >
              Approve all edits · switch to »» auto-edit
            </button>
          ) : request.canRemember ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={sending}
              onClick={() => decide({ kind: "approve-remember" })}
            >
              Approve and don’t ask again
            </button>
          ) : null}
          <span className="grow" />
          <button
            type="button"
            className="btn-danger"
            disabled={sending}
            onClick={() => reject()}
          >
            Reject <kbd>Esc</kbd>
          </button>
        </div>
        {request.type === "edit" ? (
          <div className="sandbox-line">
            {request.insideSandbox ? (
              <span style={{ color: "var(--ok)" }}>[ OK ]</span>
            ) : (
              <span className="bad">[ !! ]</span>
            )}{" "}
            {request.insideSandbox ? "inside sandbox" : "outside sandbox"}{" "}
            {shortPath(request.sandbox.replace(/^Filesystem access limited to /, "").split(",")[0])}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
