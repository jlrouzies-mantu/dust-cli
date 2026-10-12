import { useEffect, useState } from "react";

import type { AuthStatus } from "../shared/ipc";
import { Logo } from "./Logo";
import { toast } from "./store";

function Hero() {
  return (
    <div className="hero" aria-hidden="true">
      <div className="shape s1" />
      <div className="shape s2" />
      <div className="shape s3" />
      <Logo className="big" />
      <div className="tagline">
        <div className="y">Audacious ideas,</div>
        <div className="w">delivered beyond.</div>
      </div>
    </div>
  );
}

function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((until - now) / 1000));
  return (
    <>
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    </>
  );
}

export function SignIn({ status }: { status: AuthStatus }) {
  const [copied, setCopied] = useState(false);
  const [starting, setStarting] = useState(false);

  const start = async () => {
    setStarting(true);
    const res = await window.dustm.auth.start();
    if (!res.ok) {
      toast(res.error ?? "Could not start sign-in.");
    }
    setStarting(false);
  };

  const copy = async () => {
    const res = await window.dustm.auth.copyCode();
    if (res.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  let content;
  if (status.kind === "signing-in") {
    content = (
      <>
        <h1>Confirm in your browser</h1>
        <p>
          Check that this code matches the one on the Dust page, then approve the
          sign-in. This window continues by itself.
        </p>
        <div
          className="code"
          role="img"
          aria-label={`Your sign-in code is ${status.userCode.split("").join(" ")}`}
        >
          {status.userCode}
        </div>
        <div className="btn-row">
          <button type="button" className="btn-primary" onClick={() => void window.dustm.auth.openBrowser()}>
            Open browser
          </button>
          <button type="button" className="btn-secondary" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy code"}
          </button>
          <span className="grow" />
          <button type="button" className="btn-quiet" onClick={() => void window.dustm.auth.cancel()}>
            Cancel
          </button>
        </div>
        <div className="status-line" role="status">
          <span className="dot" aria-hidden="true" />
          {status.phase === "saving"
            ? "Signing you in…"
            : status.phase === "slow"
              ? "Waiting for you to authorize (checking less often)…"
              : "Waiting for you to authorize…"}
          <span style={{ flex: 1 }} />
          <span>
            code expires in <Countdown until={status.expiresAt} />
          </span>
        </div>
        <p className="mono" style={{ fontSize: 12 }}>
          {status.verificationUri}
        </p>
      </>
    );
  } else if (status.kind === "choose-workspace") {
    content = (
      <>
        <h1>Choose a workspace</h1>
        <p>You belong to several Dust workspaces. Pick the one to work in.</p>
        <div className="ws-list" role="listbox" aria-label="Workspaces">
          {status.workspaces.map((w, i) => (
            <button
              key={w.sId}
              type="button"
              role="option"
              aria-selected={false}
              className="opt"
              autoFocus={i === 0}
              onClick={() =>
                void window.dustm.auth.selectWorkspace(w.sId).then((r) => {
                  if (!r.ok) toast(r.error ?? "Could not select the workspace.");
                })
              }
            >
              <span className="id">{w.name}</span>
              <span className="tag">{w.role}</span>
            </button>
          ))}
        </div>
        <div className="btn-row">
          <button type="button" className="btn-quiet" onClick={() => void window.dustm.auth.signOut()}>
            Sign out
          </button>
        </div>
      </>
    );
  } else if (status.kind === "error") {
    content = (
      <>
        <h1>Something went wrong</h1>
        <div className="err-box" role="alert">{status.message}</div>
        <div className="btn-row">
          <button type="button" className="btn-primary" disabled={starting} onClick={() => void start()}>
            Sign in again
          </button>
        </div>
      </>
    );
  } else {
    content = (
      <>
        <h1>Sign in to Dust</h1>
        <p>
          dustm Desktop uses the same sign-in as the dustm command line. Signing in
          here also signs in <span className="mono">dustm</span> in your terminal,
          and the other way around.
        </p>
        {status.kind === "signed-out" && status.reason ? (
          <div className="err-box" role="alert">{status.reason}</div>
        ) : null}
        <div className="btn-row">
          <button type="button" className="btn-primary" autoFocus disabled={starting} onClick={() => void start()}>
            Sign in with your browser
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="signin">
      <Hero />
      <main className="signin-main">
        <div className="signin-card">{content}</div>
      </main>
    </div>
  );
}
