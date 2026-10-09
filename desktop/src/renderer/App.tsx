import { useCallback, useEffect, useMemo, useState } from "react";

import type { SessionState } from "../shared/ipc";
import { ApprovalDialog } from "./ApprovalDialog";
import { Composer } from "./Composer";
import { AgentPicker, CommandPalette, ModelPicker, ResumePicker, SkillsDialog } from "./Palette";
import type { Command } from "./Palette";
import { Aside, Sidebar, StatusBar } from "./Panels";
import { SignIn } from "./SignIn";
import { Transcript } from "./Transcript";
import { boot, toast, useApp } from "./store";

type Overlay = null | "palette" | "model" | "agent" | "resume" | "skills";

function TitleBar({ session, onPalette }: { session: SessionState | null; onPalette?: () => void }) {
  return (
    <>
      <header className="titlebar">
        <span className="name">dustm</span>
        <span className="fork">MANTU FORK</span>
        {session ? (
          <span className="ver">
            v{session.version} (upstream v{session.upstreamVersion})
          </span>
        ) : null}
        <span className="spacer" />
        {session?.mode === "plan" ? (
          <span className="mode-banner">■ plan · writes blocked</span>
        ) : null}
        {onPalette ? (
          <button type="button" className="pill-btn" onClick={onPalette}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            Commands
            <kbd>Ctrl K</kbd>
          </button>
        ) : null}
      </header>
      <div className="rule" />
    </>
  );
}

export function App() {
  const { booted, auth, session, items, firstItemIndex, approval, conversations, toast: toastState } = useApp();
  const [overlay, setOverlay] = useState<Overlay>(null);

  useEffect(() => {
    void boot();
  }, []);

  const chooseFolder = useCallback(async () => {
    const res = await window.dustm.chooseFolder();
    if (!res.ok) toast(res.error ?? "Could not set the folder.");
  }, []);

  // A file dropped outside the composer must never navigate the window.
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  // Global shortcuts. Shift+Tab lives in the composer on purpose.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (auth.kind === "ready" && !approval) {
          setOverlay((o) => (o ? null : "palette"));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [auth.kind, approval]);

  const commands = useMemo<Command[]>(
    () => [
      { id: "model", label: "/model · Choose model and effort", hint: "Live workspace list", keys: "Ctrl K", run: () => setOverlay("model") },
      { id: "agent", label: "/agent · Switch agent", hint: "Who you are talking to", run: () => setOverlay("agent") },
      { id: "new", label: "/new · New chat", hint: "Start a fresh conversation", run: () => void window.dustm.newConversation().then((r) => !r.ok && toast(r.error ?? "")) },
      { id: "folder", label: "/folder · Choose working folder", hint: "Sets the file-tool sandbox", run: () => void chooseFolder() },
      { id: "mode", label: "Cycle mode", hint: "normal → auto-edit → plan", keys: "Shift+Tab", run: () => void window.dustm.cycleMode() },
      { id: "plan", label: "/plan · Plan mode", hint: "Research only until you approve", run: () => void window.dustm.setMode("plan") },
      { id: "auto", label: "/auto · Auto-edit mode", hint: "Edits apply without asking", run: () => void window.dustm.setMode("auto") },
      { id: "normal", label: "/normal · Normal mode", hint: "You approve each edit", run: () => void window.dustm.setMode("normal") },
      { id: "signout", label: "Sign out", hint: "Also signs out the dustm CLI", run: () => void window.dustm.auth.signOut() },
      { id: "resume", label: "/resume · Resume a conversation", hint: "Recent conversations", run: () => setOverlay("resume") },
      { id: "compact", label: "/compact · Compact conversation", hint: "Summarize to free context", run: () => void window.dustm.runCommand("compact", "") },
      { id: "skills", label: "/skills · Skills", hint: "Switch local skills on and off", run: () => setOverlay("skills") },
      { id: "claude", label: "/claude-code-mode", hint: "Prime the agent with Claude Code memories", run: () => void window.dustm.runCommand("claude-code-mode", "") },
      { id: "tasks", label: "/tasks · Show tasks", hint: "Current task list", run: () => void window.dustm.runCommand("tasks", "") },
      { id: "attach", label: "/attach · Attach files", hint: "Or drop files, or paste an image", run: () => void window.dustm.attach.pickFiles() },
      { id: "update", label: "Check for updates", disabled: true, run: () => undefined },
    ],
    [chooseFolder]
  );

  let appState: string = "loading";
  if (booted) {
    appState = auth.kind === "ready" ? (session ? "ready" : "loading") : auth.kind;
  }

  let body;
  if (!booted || auth.kind === "checking") {
    body = <div className="splash" role="status">Starting…</div>;
  } else if (auth.kind !== "ready") {
    body = <SignIn status={auth} />;
  } else if (!session) {
    body = <div className="splash" role="status">Loading your workspace…</div>;
  } else {
    const last = items[items.length - 1];
    const streaming = last?.kind === "agent-text" && last.streaming;
    body = (
      <>
        <div className="body">
          <Sidebar session={session} conversations={conversations} />
          <main className="center" aria-label="Chat">
            {session.loadingConversationId ? (
              <div className="empty" role="status" aria-live="polite">
                <span className="spinner" aria-hidden="true" />
                <h1>Opening conversation…</h1>
                <p>Fetching the latest messages.</p>
              </div>
            ) : items.length === 0 ? (
              <div className="empty">
                {session.agents.length === 0 ? (
                  <>
                    <h1>Could not load agents</h1>
                    <p>{session.notice ?? "Check your connection and restart the app."}</p>
                  </>
                ) : session.folder ? (
                  <>
                    <h1>What are we working on?</h1>
                    <p>
                      @{session.agents.find((a) => a.sId === session.agentId)?.name} can read, edit and run
                      commands inside <span className="mono">{session.folder}</span>.
                    </p>
                    <button type="button" className="btn-quiet" onClick={() => void chooseFolder()}>
                      Change folder
                    </button>
                  </>
                ) : (
                  <>
                    <h1>Choose a working folder</h1>
                    <p>
                      The agent’s file and command tools are limited to one folder. Pick the project you want
                      to work on; it is remembered for next time.
                    </p>
                    <button type="button" className="btn-primary" autoFocus onClick={() => void chooseFolder()}>
                      Choose folder…
                    </button>
                  </>
                )}
                {session.notice && session.agents.length > 0 ? (
                  <div className="err-box" role="alert">{session.notice}</div>
                ) : null}
              </div>
            ) : (
              <Transcript
                items={items}
                firstItemIndex={firstItemIndex}
                context={{
                  busy: session.busy,
                  label: session.actionLabel ?? (session.thinking ? "Thinking" : null),
                  streaming,
                  pendingAgent: session.pendingAgent,
                  hasEarlier: session.hasEarlier,
                  loadingEarlier: session.loadingEarlier,
                }}
              />
            )}
            <div className="col" style={{ flex: "none" }}>
              {session.notice && items.length > 0 ? (
                <div className="err-box" role="alert" style={{ marginBottom: 8 }}>{session.notice}</div>
              ) : null}
              <Composer
                session={session}
                actions={{
                  onOpenModel: () => setOverlay("model"),
                  onOpenAgent: () => setOverlay("agent"),
                  onOpenResume: () => setOverlay("resume"),
                  onOpenSkills: () => setOverlay("skills"),
                  onChooseFolder: () => void chooseFolder(),
                }}
              />
            </div>
          </main>
          <Aside session={session} />
        </div>
        <StatusBar session={session} />
      </>
    );
  }

  return (
    <div className="app" data-app-state={appState} data-mode={session?.mode ?? "normal"}>
      <TitleBar
        session={session}
        onPalette={auth.kind === "ready" && session ? () => setOverlay("palette") : undefined}
      />
      {body}

      {overlay === "palette" ? <CommandPalette commands={commands} onClose={() => setOverlay(null)} /> : null}
      {overlay === "model" ? <ModelPicker onClose={() => setOverlay(null)} /> : null}
      {overlay === "resume" ? <ResumePicker onClose={() => setOverlay(null)} /> : null}
      {overlay === "skills" ? <SkillsDialog onClose={() => setOverlay(null)} /> : null}
      {overlay === "agent" && session ? (
        <AgentPicker agents={session.agents} currentId={session.agentId} onClose={() => setOverlay(null)} />
      ) : null}
      {approval ? <ApprovalDialog key={approval.request.id} request={approval.request} pending={approval.pending} /> : null}
      {toastState ? (
        <div className={`toast ${toastState.tone}`} role="status">
          {toastState.text}
        </div>
      ) : null}
    </div>
  );
}

