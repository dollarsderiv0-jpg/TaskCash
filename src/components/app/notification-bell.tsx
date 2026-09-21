"use client";

import * as React from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { Badge, EmptyState, Separator } from "@/components/ui/misc";
import { apiRequest } from "@/lib/client/api";
import { relativeTime } from "@/lib/money/format";
import { statusBadgeVariant } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import type { AppNotification } from "@/lib/types";

export function NotificationBell({ initialUnread }: { initialUnread: number }) {
  const [open, setOpen] = React.useState(false);
  const [unread, setUnread] = React.useState(initialUnread);
  const [items, setItems] = React.useState<AppNotification[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);

  // Close on outside click / Escape so the panel behaves like a menu.
  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);

    if (next && items === null) {
      setLoading(true);
      const result = await apiRequest<{ notifications: AppNotification[]; unread: number }>(
        "/api/notifications",
      );
      if (result.ok) {
        setItems(result.data.notifications);
        setUnread(result.data.unread);
      } else {
        setItems([]);
      }
      setLoading(false);
    }
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={toggle}
        className="relative inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card transition-colors hover:bg-secondary"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Bell className="h-4 w-4" aria-hidden />
        {unread > 0 ? (
          <span className="absolute -right-1 -top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
        >
          <div className="flex items-center justify-between px-4 py-3">
            <p className="text-sm font-semibold">Notifications</p>
            <Link
              href="/dashboard/notifications"
              className="text-xs font-medium text-primary hover:underline"
              onClick={() => setOpen(false)}
            >
              View all
            </Link>
          </div>
          <Separator />

          <div className="max-h-80 overflow-y-auto">
            {loading ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">Loading…</p>
            ) : !items || items.length === 0 ? (
              <div className="p-3">
                <EmptyState
                  title="No notifications yet"
                  description="Deposit, reward and withdrawal updates will appear here."
                  className="border-0 bg-transparent py-6"
                />
              </div>
            ) : (
              <ul>
                {items.slice(0, 8).map((item) => (
                  <li key={item.id}>
                    <Link
                      href={item.link ?? "/dashboard/notifications"}
                      onClick={() => setOpen(false)}
                      className={cn(
                        "block px-4 py-3 transition-colors hover:bg-secondary/60",
                        !item.read_at && "bg-primary/5",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm font-medium leading-snug">{item.title}</p>
                        {!item.read_at ? (
                          <Badge variant="info" className="mt-0.5 shrink-0">
                            New
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {item.message}
                      </p>
                      <p className="mt-1.5 text-[11px] text-muted-foreground">
                        {relativeTime(item.created_at)}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export { statusBadgeVariant };
