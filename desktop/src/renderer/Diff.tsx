import { memo } from "react";

import type { DiffPayload } from "../shared/ipc";

export const DiffLines = memo(function DiffLines({ diff }: { diff: DiffPayload }) {
  return (
    <div className="diff" role="table" aria-label={`Changes to ${diff.path}`}>
      {diff.lines.map((line, i) =>
        line.t === "gap" ? (
          <GapRow key={i} hidden={line.hidden} />
        ) : (
          <Row key={i} type={line.t} no={line.no} text={line.text} />
        )
      )}
      {diff.truncated ? (
        <GapRow hidden={0} label="── diff truncated ──" />
      ) : null}
    </div>
  );
});

function Row({ type, no, text }: { type: "ctx" | "add" | "del"; no: number; text: string }) {
  const sign = type === "add" ? "+ " : type === "del" ? "- " : "  ";
  const cls = type === "ctx" ? "" : type;
  return (
    <>
      <div className={`no ${cls}`} role="cell">
        {no}
      </div>
      <div className={`tx ${cls}`} role="cell">
        {sign}
        {text}
      </div>
    </>
  );
}

function GapRow({ hidden, label }: { hidden: number; label?: string }) {
  return (
    <>
      <div className="no gap">…</div>
      <div className="tx gap">{label ?? `── ${hidden} more lines ──`}</div>
    </>
  );
}
