"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/format";

/**
 * A small controlled modal. It is deliberately dependency-free — the prototype
 * only needs a centred dialog, a backdrop, scroll lock and Escape.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  hideClose = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  hideClose?: boolean;
}) {
  const [mounted, setMounted] = React.useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => setMounted(true), []);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    /* Move focus into the dialog so the keyboard follows the visual order. */
    const focusTimer = window.setTimeout(() => {
      const target = panelRef.current?.querySelector<HTMLElement>(
        "input,select,textarea,button:not([data-modal-dismiss])",
      );
      target?.focus();
    }, 40);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      window.clearTimeout(focusTimer);
    };
  }, [open, onClose]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === "string" ? title : undefined}
    >
      <div
        className="absolute inset-0 animate-fade-in bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        className={cn(
          "relative w-full animate-scale-in overflow-hidden border border-hairline bg-card shadow-lift",
          "rounded-t-card sm:max-w-md sm:rounded-card",
          className,
        )}
      >
        {title || !hideClose ? (
          <div className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-4">
            <div className="min-w-0">
              {title ? (
                <h2 className="truncate text-base font-bold tracking-tight text-white">{title}</h2>
              ) : null}
              {description ? (
                <p className="mt-0.5 text-xs leading-snug text-muted">{description}</p>
              ) : null}
            </div>
            {hideClose ? null : (
              <button
                type="button"
                data-modal-dismiss
                onClick={onClose}
                aria-label="Close dialog"
                className="-mr-1 rounded-md p-1.5 text-muted transition hover:bg-white/5 hover:text-white"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
        ) : null}

        <div className="px-5 py-4">{children}</div>

        {footer ? (
          <div className="border-t border-hairline bg-cardAlt/60 px-5 py-4">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
