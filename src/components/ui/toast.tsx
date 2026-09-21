"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastTone = "info" | "success" | "warning" | "error";

export type Toast = {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
};

type ToastContextValue = {
  toast: (input: { title: string; description?: string; tone?: ToastTone }) => void;
};

const ToastContext = React.createContext<ToastContextValue | null>(null);

const TONE_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
} as const;

const TONE_STYLE: Record<ToastTone, string> = {
  info: "border-sky-500/30",
  success: "border-emeraldBrand-500/35",
  warning: "border-amber-500/35",
  error: "border-destructive/40",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  const dismiss = React.useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = React.useCallback<ToastContextValue["toast"]>(
    ({ title, description, tone = "info" }) => {
      const id = Math.random().toString(36).slice(2, 10);
      setToasts((current) => [...current.slice(-3), { id, title, description, tone }]);
      // Payment-related messages stay longer than routine ones.
      const duration = tone === "error" || tone === "warning" || tone === "success" ? 8000 : 5000;
      setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const value = React.useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6 sm:right-6 sm:left-auto sm:items-end"
      >
        {toasts.map((t) => {
          const Icon = TONE_ICON[t.tone];
          return (
            <div
              key={t.id}
              className={cn(
                "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-card p-3.5 shadow-lg",
                "animate-in slide-in-from-bottom-2 fade-in",
                TONE_STYLE[t.tone],
              )}
              role={t.tone === "error" ? "alert" : "status"}
            >
              <Icon
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0",
                  t.tone === "success" && "text-emeraldBrand-600 dark:text-emeraldBrand-400",
                  t.tone === "error" && "text-destructive",
                  t.tone === "warning" && "text-amber-600 dark:text-amber-400",
                  t.tone === "info" && "text-sky-600 dark:text-sky-400",
                )}
                aria-hidden
              />
              <div className="flex-1 space-y-0.5">
                <p className="text-sm font-semibold leading-snug">{t.title}</p>
                {t.description ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">{t.description}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="rounded-md p-1 text-muted-foreground hover:bg-secondary"
                aria-label="Dismiss notification"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

/**
 * Shared error surface: API responses are already mapped to safe, human
 * messages server-side, so we display `error.message` and never a raw stack.
 */
export async function readApiError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? "Something went wrong. Please try again.";
  } catch {
    return "Something went wrong. Please try again.";
  }
}
