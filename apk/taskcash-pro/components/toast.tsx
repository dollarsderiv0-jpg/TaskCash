"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "@/lib/format";

type ToastVariant = "success" | "error" | "info";

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
}

interface ToastApi {
  toast: (input: Omit<ToastItem, "id"> | string, variant?: ToastVariant) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = React.createContext<ToastApi | null>(null);

let toastSeq = 0;

const VARIANT_STYLES: Record<ToastVariant, { ring: string; icon: string; Icon: typeof Info }> = {
  success: { ring: "border-cash/40", icon: "text-cash", Icon: CheckCircle2 },
  error: { ring: "border-flame/45", icon: "text-flame-400", Icon: AlertTriangle },
  info: { ring: "border-brand/45", icon: "text-brand-400", Icon: Info },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const timers = React.useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = React.useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = React.useCallback(
    (title: string, variant: ToastVariant, description?: string) => {
      const id = (toastSeq += 1);
      setItems((prev) => [...prev.slice(-2), { id, title, description, variant }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), 4200),
      );
    },
    [dismiss],
  );

  React.useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      timers.current.clear();
    },
    [],
  );

  const api = React.useMemo<ToastApi>(
    () => ({
      toast: (input, variant = "info") =>
        typeof input === "string"
          ? push(input, variant)
          : push(input.title, input.variant, input.description),
      success: (title, description) => push(title, "success", description),
      error: (title, description) => push(title, "error", description),
      info: (title, description) => push(title, "info", description),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster items={items} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/** The visual stack. Split out so the provider stays free of layout concerns. */
export function Toaster({
  items,
  onDismiss,
}: {
  items: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-20 z-[70] flex flex-col items-center gap-2 sm:bottom-6 sm:left-auto sm:right-6 sm:items-end">
      {items.map((item) => {
        const { ring, icon, Icon } = VARIANT_STYLES[item.variant];
        return (
          <div
            key={item.id}
            role="status"
            className={cn(
              "pointer-events-auto w-full max-w-sm animate-slide-in-right rounded-tile border bg-cardAlt/95 p-3 shadow-lift backdrop-blur",
              ring,
            )}
          >
            <div className="flex items-start gap-3">
              <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", icon)} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-snug text-white">{item.title}</p>
                {item.description ? (
                  <p className="mt-0.5 text-xs leading-snug text-muted">{item.description}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => onDismiss(item.id)}
                aria-label="Dismiss notification"
                className="-mr-1 -mt-1 rounded-md p-1 text-muted transition hover:bg-white/5 hover:text-white"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>.");
  return ctx;
}
