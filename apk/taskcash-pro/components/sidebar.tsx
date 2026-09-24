"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { SIDEBAR_NAV, isActivePath } from "@/lib/nav";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/format";
import { Brand } from "./brand";

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { logout, state } = useStore();

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[236px] flex-col border-r border-hairline bg-base/80 backdrop-blur lg:flex">
      <div className="px-5 py-5">
        <Brand />
      </div>

      <nav className="flex-1 space-y-1 px-3" aria-label="Primary">
        {SIDEBAR_NAV.map((item) => {
          const active = isActivePath(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-tile px-3 py-2.5 text-sm font-semibold transition",
                active
                  ? "bg-flame/12 text-white"
                  : "text-muted hover:bg-white/[0.04] hover:text-white",
              )}
            >
              <Icon
                className={cn("h-[18px] w-[18px] shrink-0", active ? "text-flame-400" : "text-current")}
                aria-hidden
              />
              <span className="truncate">{item.label}</span>
              {active ? (
                <span aria-hidden className="ml-auto h-4 w-[3px] rounded-full bg-flame" />
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-hairline p-3">
        <div className="mb-2 flex items-center gap-3 rounded-tile px-2 py-2">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand/20 text-[11px] font-bold text-brand-400">
            {state.user.avatarInitials}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold text-white">
              {state.user.name}
            </span>
            <span className="block truncate text-[11px] text-muted">{state.user.email}</span>
          </span>
        </div>
        <button
          type="button"
          onClick={() => {
            logout();
            router.push("/login");
          }}
          className="flex w-full items-center gap-3 rounded-tile px-3 py-2.5 text-sm font-semibold text-muted transition hover:bg-white/[0.04] hover:text-flame-400"
        >
          <LogOut className="h-[18px] w-[18px]" aria-hidden />
          Logout
        </button>
        <p className="px-3 pt-2 text-[10px] leading-snug text-muted/70">
          Demo interface only. No real money moves.
        </p>
      </div>
    </aside>
  );
}
