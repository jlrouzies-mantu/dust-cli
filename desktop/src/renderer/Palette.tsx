import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";

import type { AgentInfo, Effort, ModelList, ModelRow } from "../shared/ipc";
import { contextBar } from "./format";
import { Modal } from "./Modal";
import { toast, useApp } from "./store";
import { formatContextSize } from "../../../src/utils/modelSelection";

/** Up/Down/Home/End over a list; returns the next index or null. */
function navigate(e: KeyboardEvent, index: number, count: number): number | null {
  if (count === 0) return null;
  if (e.key === "ArrowDown") return (index + 1) % count;
  if (e.key === "ArrowUp") return (index - 1 + count) % count;
  if (e.key === "Home") return 0;
  if (e.key === "End") return count - 1;
  return null;
}

// ------------------------------------------------------------ models

const EFFORTS: { id: Effort | null; label: string; hint: string }[] = [
  { id: null, label: "default", hint: "The agent's own setting" },
  { id: "high", label: "high", hint: "Most thinking, slowest" },
  { id: "medium", label: "medium", hint: "Balanced" },
  { id: "light", label: "light", hint: "Little thinking, faster" },
  { id: "none", label: "none", hint: "No reasoning step at all" },
];

type Entry =
  | { kind: "model"; row: ModelRow }
  | { kind: "raw"; id: string }
  | { kind: "reset" };

export function ModelPicker({
  onClose,
  initialQuery = "",
}: {
  onClose: () => void;
  initialQuery?: string;
}) {
  const { session } = useApp();
  const [list, setList] = useState<ModelList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    void window.dustm.listModels().then((res) => {
      if (res.ok && res.value) {
        setList(res.value);
      } else {
        setLoadError(res.error ?? "Could not load models.");
      }
    });
  }, []);

  const activeId = session?.modelOverride?.modelId ?? null;
  const q = query.trim().toLowerCase();

  const entries = useMemo<Entry[]>(() => {
    const rows = (list?.models ?? []).filter(
      (m) =>
        !q ||
        m.modelId.toLowerCase().includes(q) ||
        m.label.toLowerCase().includes(q)
    );
    const out: Entry[] = rows.map((row) => ({ kind: "model", row }));
    // A model id outside the list is still allowed: the server is the only
    // thing that can say it is invalid (see AGENTS.md, modelSelection.ts).
    if (q && rows.length === 0) {
      out.push({ kind: "raw", id: query.trim() });
    }
    if (!q) {
      out.push({ kind: "reset" });
    }
    return out;
  }, [list, q, query]);

  useEffect(() => setIndex(0), [q]);

  const choose = async (entry: Entry | undefined) => {
    if (!entry) return;
    const res = await window.dustm.setModel(
      entry.kind === "reset"
        ? null
        : entry.kind === "raw"
          ? entry.id
          : entry.row.modelId
    );
    if (!res.ok) {
      toast(res.error ?? "Could not set the model.");
      return;
    }
    onClose();
  };

  const setEffort = async (effort: Effort | null) => {
    const res = await window.dustm.setEffort(effort);
    if (!res.ok) toast(res.error ?? "Could not set effort.");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    const next = navigate(e, index, entries.length);
    if (next !== null && (e.target as HTMLElement).tagName === "INPUT") {
      e.preventDefault();
      setIndex(next);
      document.getElementById(`model-opt-${next}`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
      e.preventDefault();
      void choose(entries[index]);
    }
  };

  let lastProvider = "";
  const agentModel = session?.agents.find((a) => a.sId === session.agentId)?.model;

  return (
    <Modal label="Choose a model" className="palette" top onKeyDown={onKeyDown} onEscape={onClose} initialFocus="#model-q">
      <div className="pal-top" />
      <div className="pal-input">
        <span className="bar" aria-hidden="true" />
        <span className="cmd" aria-hidden="true">/model</span>
        <label htmlFor="model-q" className="sr-only">
          Filter models
        </label>
        <input
          id="model-q"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="model-list"
          aria-activedescendant={`model-opt-${index}`}
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder="filter, or type a model id"
          onChange={(e) => setQuery(e.target.value)}
        />
        {list ? (
          <span className={`meta ${list.source === "live" ? "" : "warn"}`}>
            {list.source === "live"
              ? `● live list · ${list.models.length}`
              : `○ built-in list · ${list.models.length}`}
          </span>
        ) : null}
      </div>

      <div className="pal-list" role="listbox" id="model-list" aria-label="Models">
        {!list && !loadError ? <div className="pal-empty">Loading models…</div> : null}
        {loadError ? <div className="pal-empty">{loadError}</div> : null}
        {entries.map((entry, i) => {
          if (entry.kind === "model") {
            const m = entry.row;
            const header =
              m.providerId !== lastProvider ? (
                <div key={`h-${m.providerId}`} className="pal-group" role="presentation">
                  ── {m.providerId}
                </div>
              ) : null;
            lastProvider = m.providerId;
            const tags = [...m.tags];
            if (m.modelId === activeId) tags.unshift("selected");
            return (
              <div key={`${m.providerId}-${m.modelId}`} role="presentation">
                {header}
                <button
                  type="button"
                  role="option"
                  id={`model-opt-${i}`}
                  aria-selected={i === index}
                  className="opt"
                  tabIndex={-1}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => void choose(entry)}
                >
                  <span className="id">{m.label}</span>
                  <span className="bar" aria-hidden="true">{contextBar(m.contextSize)}</span>
                  <span className="ctx">
                    {m.contextSize ? formatContextSize(m.contextSize) : ""}
                  </span>
                  <span className="tags">
                    {tags.slice(0, 2).map((t) => (
                      <span key={t} className={`tag ${t}`}>
                        {t}
                      </span>
                    ))}
                  </span>
                </button>
              </div>
            );
          }
          if (entry.kind === "raw") {
            return (
              <button
                key="raw"
                type="button"
                role="option"
                id={`model-opt-${i}`}
                aria-selected={i === index}
                className="opt"
                tabIndex={-1}
                onClick={() => void choose(entry)}
              >
                <span className="id">Use “{entry.id}” anyway</span>
                <span className="desc">not in the list; the server will validate it</span>
              </button>
            );
          }
          return (
            <div key="reset" role="presentation">
              <div className="pal-group" role="presentation">── reset</div>
              <button
                type="button"
                role="option"
                id={`model-opt-${i}`}
                aria-selected={i === index}
                className="opt"
                tabIndex={-1}
                onMouseMove={() => setIndex(i)}
                onClick={() => void choose(entry)}
              >
                <span className="id">default</span>
                <span className="desc">
                  the agent's own model{agentModel ? ` · ${agentModel.modelId}` : ""}
                </span>
              </button>
            </div>
          );
        })}
        {list && entries.length === 0 ? <div className="pal-empty">No matching model.</div> : null}
      </div>

      <div className="pal-foot">
        <span className="lbl" id="effort-label">Effort</span>
        <div className="radios" role="radiogroup" aria-labelledby="effort-label">
          {EFFORTS.map((e) => (
            <button
              key={e.label}
              type="button"
              role="radio"
              aria-checked={(session?.effort ?? null) === e.id}
              className="radio"
              title={e.hint}
              onClick={() => void setEffort(e.id)}
            >
              {e.label}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <span className="pal-keys">↑↓ move · Enter choose · Esc close</span>
      </div>
      <div className="pal-note">
        This conversation only. The agent's saved configuration stays as it is.
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ agents

export function AgentPicker({
  agents,
  currentId,
  onClose,
}: {
  agents: AgentInfo[];
  currentId: string | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const q = query.trim().toLowerCase();
  const rows = agents.filter(
    (a) => !q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)
  );
  useEffect(() => setIndex(0), [q]);

  const choose = async (a: AgentInfo | undefined) => {
    if (!a) return;
    const res = await window.dustm.selectAgent(a.sId);
    if (!res.ok) {
      toast(res.error ?? "Could not switch agent.");
      return;
    }
    onClose();
  };

  return (
    <Modal
      label="Choose an agent"
      className="palette"
      top
      onEscape={onClose}
      initialFocus="#agent-q"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
          return;
        }
        const next = navigate(e, index, rows.length);
        if (next !== null) {
          e.preventDefault();
          setIndex(next);
          document.getElementById(`agent-opt-${next}`)?.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
          e.preventDefault();
          void choose(rows[index]);
        }
      }}
    >
      <div className="pal-top" />
      <div className="pal-input">
        <span className="bar" aria-hidden="true" />
        <span className="cmd" aria-hidden="true">@agent</span>
        <label htmlFor="agent-q" className="sr-only">Filter agents</label>
        <input
          id="agent-q"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="agent-list"
          aria-activedescendant={`agent-opt-${index}`}
          autoComplete="off"
          value={query}
          placeholder="filter agents"
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="meta">{agents.length} agents</span>
      </div>
      <div className="pal-list" role="listbox" id="agent-list" aria-label="Agents">
        {rows.map((a, i) => (
          <button
            key={a.sId}
            type="button"
            role="option"
            id={`agent-opt-${i}`}
            aria-selected={i === index}
            className="opt"
            tabIndex={-1}
            onMouseMove={() => setIndex(i)}
            onClick={() => void choose(a)}
          >
            <span className="id">@{a.name}</span>
            <span className="desc" style={{ flex: 2, minWidth: 0 }}>
              {a.description.slice(0, 90)}
            </span>
            {a.sId === currentId ? <span className="tag current">current</span> : null}
          </button>
        ))}
        {rows.length === 0 ? <div className="pal-empty">No matching agent.</div> : null}
      </div>
      <div className="pal-foot">
        <span className="pal-keys">↑↓ move · Enter choose · Esc close</span>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ commands

export interface Command {
  id: string;
  label: string;
  hint?: string;
  keys?: string;
  disabled?: boolean;
  run: () => void;
}

export function CommandPalette({
  commands,
  onClose,
}: {
  commands: Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const q = query.trim().toLowerCase().replace(/^\//, "");
  const rows = commands.filter(
    (c) => !q || c.label.toLowerCase().includes(q) || c.id.includes(q)
  );
  useEffect(() => setIndex(0), [q]);

  const run = (c: Command | undefined) => {
    if (!c || c.disabled) return;
    onClose();
    // After the palette unmounts, so a dialog it opens keeps the focus.
    setTimeout(c.run, 0);
  };

  return (
    <Modal
      label="Commands"
      className="palette"
      top
      onEscape={onClose}
      initialFocus="#cmd-q"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
          return;
        }
        const next = navigate(e, index, rows.length);
        if (next !== null) {
          e.preventDefault();
          setIndex(next);
          document.getElementById(`cmd-opt-${next}`)?.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
          e.preventDefault();
          run(rows[index]);
        }
      }}
    >
      <div className="pal-top" />
      <div className="pal-input">
        <span className="bar" aria-hidden="true" />
        <span className="cmd" aria-hidden="true">/</span>
        <label htmlFor="cmd-q" className="sr-only">Search commands</label>
        <input
          id="cmd-q"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="cmd-list"
          aria-activedescendant={`cmd-opt-${index}`}
          autoComplete="off"
          value={query}
          placeholder="type a command"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="pal-list" role="listbox" id="cmd-list" aria-label="Commands">
        {rows.map((c, i) => (
          <button
            key={c.id}
            type="button"
            role="option"
            id={`cmd-opt-${i}`}
            aria-selected={i === index}
            aria-disabled={c.disabled || undefined}
            className="opt"
            tabIndex={-1}
            onMouseMove={() => setIndex(i)}
            onClick={() => run(c)}
          >
            <span className="id">{c.label}</span>
            {c.disabled ? (
              <span className="soon">coming soon</span>
            ) : (
              <span className="desc">{c.hint}</span>
            )}
            {c.keys ? <span className="soon">{c.keys}</span> : null}
          </button>
        ))}
        {rows.length === 0 ? <div className="pal-empty">No matching command.</div> : null}
      </div>
      <div className="pal-foot">
        <span className="pal-keys">↑↓ move · Enter run · Esc close</span>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ resume

export function ResumePicker({ onClose }: { onClose: () => void }) {
  const { conversations, session } = useApp();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const q = query.trim().toLowerCase();
  const rows = (conversations ?? []).filter((c) => !q || c.title.toLowerCase().includes(q));
  useEffect(() => setIndex(0), [q]);

  const choose = async (id: string | undefined) => {
    if (!id) return;
    onClose();
    if (id === session?.conversationId) return;
    const res = await window.dustm.loadConversation(id);
    if (!res.ok) toast(res.error ?? "Could not open the conversation.");
  };

  return (
    <Modal
      label="Resume a conversation"
      className="palette"
      top
      onEscape={onClose}
      initialFocus="#resume-q"
      onKeyDown={(e) => {
        const next = navigate(e, index, rows.length);
        if (next !== null) {
          e.preventDefault();
          setIndex(next);
          document.getElementById(`resume-opt-${next}`)?.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
          e.preventDefault();
          void choose(rows[index]?.sId);
        }
      }}
    >
      <div className="pal-top" />
      <div className="pal-input">
        <span className="bar" aria-hidden="true" />
        <span className="cmd" aria-hidden="true">/resume</span>
        <label htmlFor="resume-q" className="sr-only">Filter conversations</label>
        <input
          id="resume-q"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="resume-list"
          aria-activedescendant={`resume-opt-${index}`}
          autoComplete="off"
          value={query}
          placeholder="filter by title"
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="meta">{conversations?.length ?? 0} conversations</span>
      </div>
      <div className="pal-list" role="listbox" id="resume-list" aria-label="Conversations">
        {rows.map((c, i) => (
          <button
            key={c.sId}
            type="button"
            role="option"
            id={`resume-opt-${i}`}
            aria-selected={i === index}
            className="opt"
            tabIndex={-1}
            onMouseMove={() => setIndex(i)}
            onClick={() => void choose(c.sId)}
          >
            <span className="id" style={{ fontFamily: "var(--font-body)", fontSize: 14 }}>{c.title}</span>
            <span className="desc">{new Date(c.updated).toLocaleDateString()}</span>
          </button>
        ))}
        {rows.length === 0 ? <div className="pal-empty">No matching conversation.</div> : null}
      </div>
      <div className="pal-foot">
        <span className="pal-keys">↑↓ move · Enter open · Esc close</span>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ skills

export function SkillsDialog({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<{
    skills: { name: string; description: string | null; source: string; enabled: boolean }[];
    claudeCodeMode: boolean;
    summary: string[];
  } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [index, setIndex] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.dustm.skills.list().then((res) => {
      if (res.ok && res.value) {
        setData(res.value);
        setChecked(new Set(res.value.skills.filter((s) => s.enabled).map((s) => s.name)));
      } else {
        toast(res.error ?? "Could not list skills.");
        onClose();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (name: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  const save = async () => {
    setSaving(true);
    const res = await window.dustm.skills.setEnabled([...checked]);
    setSaving(false);
    if (!res.ok) toast(res.error ?? "Could not save.");
    onClose();
  };

  const skills = data?.skills ?? [];
  return (
    <Modal
      label="Skills"
      className="palette"
      top
      onEscape={onClose}
      initialFocus="#skills-list"
      onKeyDown={(e) => {
        const next = navigate(e, index, skills.length);
        if (next !== null) {
          e.preventDefault();
          setIndex(next);
          document.getElementById(`skill-opt-${next}`)?.scrollIntoView({ block: "nearest" });
        } else if (e.key === " " && skills[index] && (e.target as HTMLElement).id === "skills-list") {
          e.preventDefault();
          toggle(skills[index].name);
        } else if (e.key === "Enter" && (e.target as HTMLElement).id === "skills-list") {
          e.preventDefault();
          void save();
        }
      }}
    >
      <div className="pal-top" />
      <div className="pal-input">
        <span className="bar" aria-hidden="true" />
        <span className="cmd" aria-hidden="true">/skills</span>
        <span className="sr-only" id="skills-label">Skills checklist</span>
        <span style={{ flex: 1, color: "var(--muted-2)", fontSize: 13, padding: "18px 0" }}>
          Switch local skills on and off
        </span>
      </div>
      <div
        className="pal-list"
        role="listbox"
        id="skills-list"
        tabIndex={0}
        aria-multiselectable="true"
        aria-labelledby="skills-label"
        aria-activedescendant={skills.length ? `skill-opt-${index}` : undefined}
      >
        {!data ? <div className="pal-empty">Loading skills…</div> : null}
        {data && skills.length === 0 ? (
          <div className="pal-empty">
            {data.summary.map((l) => (
              <div key={l}>{l}</div>
            ))}
          </div>
        ) : null}
        {skills.map((k, i) => (
          <div
            key={k.name}
            role="option"
            id={`skill-opt-${i}`}
            aria-selected={checked.has(k.name)}
            className="opt"
            onMouseMove={() => setIndex(i)}
            onClick={() => toggle(k.name)}
            data-active={i === index}
          >
            <span className="mono" aria-hidden="true">{checked.has(k.name) ? "[x]" : "[ ]"}</span>
            <span className="id">{k.name}</span>
            <span className="desc" style={{ flex: 2, minWidth: 0 }}>{(k.description ?? "").slice(0, 80)}</span>
          </div>
        ))}
      </div>
      <div className="pal-foot">
        <button type="button" className="btn-primary" disabled={!data || saving} onClick={() => void save()}>
          Save
        </button>
        <button type="button" className="btn-quiet" onClick={onClose}>
          Cancel
        </button>
        <span style={{ flex: 1 }} />
        <span className="pal-keys">↑↓ move · Space toggle · Enter save · Esc discard</span>
      </div>
      {data && !data.claudeCodeMode ? (
        <div className="pal-note">To get .claude skills, enable /claude-code-mode first.</div>
      ) : null}
    </Modal>
  );
}

// ------------------------------------------------------------ parallel agents

/** How many turns may run at once across all conversations (1-8, remembered). */
export function ParallelDialog({ onClose }: { onClose: () => void }) {
  const { session } = useApp();
  const current = session?.maxParallel ?? 3;
  const choose = async (n: number) => {
    const res = await window.dustm.setMaxParallel(n);
    if (!res.ok) {
      toast(res.error ?? "Could not change the limit.");
      return;
    }
    onClose();
  };
  return (
    <Modal
      label="Maximum parallel agents"
      className="palette"
      top
      onEscape={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="pal-top" />
      <div style={{ padding: "14px 18px 18px" }}>
        <h2 style={{ margin: "0 0 6px", fontSize: 15 }}>Max parallel agents</h2>
        <p className="plain-note" style={{ margin: "0 0 12px" }}>
          How many conversations may have an agent working at once. A message sent beyond the limit
          waits for a free slot.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
            <button
              key={n}
              type="button"
              className="small-btn"
              aria-pressed={n === current}
              style={n === current ? { borderColor: "var(--yellow)", color: "#fff" } : undefined}
              onClick={() => void choose(n)}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
