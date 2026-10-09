import { useEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal shell: role=dialog + aria-modal, focus moves in on open,
 * Tab is trapped, and focus returns to whatever had it when the dialog closes.
 * Escape handling is left to the caller (it means "reject" in some dialogs and
 * "close" in others).
 */
export function Modal({
  children,
  className = "",
  labelledBy,
  label,
  top = false,
  onKeyDown,
  onEscape,
  initialFocus,
}: {
  children: ReactNode;
  className?: string;
  labelledBy?: string;
  label?: string;
  top?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  /** Escape anywhere in the window, even if focus has left the dialog. */
  onEscape?: () => void;
  initialFocus?: string;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const target =
      (initialFocus && root?.querySelector<HTMLElement>(initialFocus)) ||
      root?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    return () => {
      // Closing a popover returns the user to the message box.
      const composer = document.getElementById("composer");
      (composer ?? previous)?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A click on the dialog's own non-focusable background moves focus to the
  // body, outside the dialog, where its key handler never sees Escape. So
  // Escape is also caught on the window.
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && escapeRef.current) {
        e.preventDefault();
        escapeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const trap = (e: KeyboardEvent<HTMLElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || e.key !== "Tab" || !ref.current) {
      return;
    }
    const nodes = Array.from(
      ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)
    ).filter((n) => n.offsetParent !== null);
    if (nodes.length === 0) {
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={`scrim ${top ? "top" : ""}`}>
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        className={`dialog ${className}`}
        onKeyDown={trap}
      >
        {children}
      </section>
    </div>
  );
}
