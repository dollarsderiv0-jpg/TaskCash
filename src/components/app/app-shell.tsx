"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Bell,
  Download,
  Gift,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Megaphone,
  Package as PackageIcon,
  PlayCircle,
  Settings,
  ShieldCheck,
  UserRound,
  Users,
  Wallet,
} from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { NotificationBell } from "@/components/app/notification-bell";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/misc";
import { cn, initials } from "@/lib/utils";
import { formatMoney } from "@/lib/money/format";

const PRIMARY_NAV = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard },
  { href: "/dashboard/watch", label: "Watch", icon: PlayCircle },
  { href: "/dashboard/wallet", label: "Wallet", icon: Wallet },
  { href: "/dashboard/referrals", label: "Refer", icon: Gift },
  { href: "/dashboard/profile", label: "Profile", icon: UserRound },
];

const SECONDARY_NAV = [
  // Packages sit with the money links rather than in the primary bar: a package
  // is bought from the wallet, not browsed like the watch page.
  { href: "/dashboard/packages", label: "Packages", icon: PackageIcon },
  { href: "/dashboard/deposit", label: "Deposit", icon: ArrowDownToLine },
  { href: "/dashboard/withdraw", label: "Withdraw", icon: ArrowUpFromLine },
  { href: "/dashboard/redeem", label: "Redeem Code", icon: Gift },
  { href: "/dashboard/groups", label: "Groups", icon: Users },
  { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
  { href: "/dashboard/install", label: "Install App", icon: Download },
];

/*
  Kept separate from the money links they used to sit with: "Help & Support"
  was filed under a heading that said Money, and the sponsored gallery has
  nothing to do with money either. Grouping by what the links are for makes the
  sidebar honest about itself.
*/
const DISCOVER_NAV = [
  { href: "/dashboard/ads", label: "Advertisements", icon: Megaphone },
  { href: "/support", label: "Help & Support", icon: LifeBuoy },
];

export type ShellUser = {
  fullName: string;
  email: string;
  currency: string;
  availableBalance: number;
  lockedBalance: number;
  isAdmin: boolean;
  unread: number;
};

export function AppShell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = React.useState(false);

  async function logout() {
    setLoggingOut(true);
    /*
      `/sign-out`, not `/`. The root route opens the brand mark and sends a
      signed-out visitor to the sign-up form, so landing there after signing out
      invited somebody to register for the account they had just left.
    */
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/sign-out");
    router.refresh();
  }

  return (
    <div className="min-h-dvh bg-background lg:pl-72">
      {/* ---------------------------------------------------------------- */}
      {/* Desktop sidebar                                                  */}
      {/* ---------------------------------------------------------------- */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-72 flex-col border-r border-border bg-card/50 lg:flex">
        <div className="flex h-16 items-center px-5">
          <Link href="/dashboard" aria-label="TaskCash Pro dashboard">
            <Logo size="sm" />
          </Link>
        </div>

        <div className="px-4">
          <div className="rounded-2xl border border-border bg-background/70 p-4">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Balance · {user.currency}
            </p>
            <p className="mt-1 text-2xl font-bold tracking-tight">
              {formatMoney(user.availableBalance, user.currency)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Locked {formatMoney(user.lockedBalance, user.currency)}
            </p>
          </div>
        </div>

        <nav aria-label="Main" className="mt-5 flex-1 space-y-1 px-3">
          {PRIMARY_NAV.map((item) => (
            <SidebarLink key={item.href} {...item} active={isActive(pathname, item.href)} />
          ))}

          <p className="px-3 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Money
          </p>
          {SECONDARY_NAV.map((item) => (
            <SidebarLink key={item.href} {...item} active={isActive(pathname, item.href)} />
          ))}

          <p className="px-3 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Discover
          </p>
          {DISCOVER_NAV.map((item) => (
            <SidebarLink key={item.href} {...item} active={isActive(pathname, item.href)} />
          ))}

          {user.isAdmin ? (
            <>
              <p className="px-3 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Operations
              </p>
              <SidebarLink
                href="/admin"
                label="Admin panel"
                icon={ShieldCheck}
                active={pathname.startsWith("/admin")}
              />
              <SidebarLink
                href="/admin/settings"
                label="Settings"
                icon={Settings}
                active={pathname === "/admin/settings"}
              />
            </>
          ) : null}
        </nav>

        <div className="border-t border-border p-3">
          <div className="flex items-center gap-3 rounded-xl px-2 py-2">
            <Avatar className="h-9 w-9">
              <AvatarFallback>{initials(user.fullName) || "TC"}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user.fullName}</p>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
            </div>
          </div>
          <Button
            variant="ghost"
            className="mt-1 w-full justify-start gap-3 px-2 text-muted-foreground"
            onClick={logout}
            loading={loggingOut}
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Sign out
          </Button>
        </div>
      </aside>

      {/* ---------------------------------------------------------------- */}
      {/* Mobile top bar                                                   */}
      {/* ---------------------------------------------------------------- */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-lg lg:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <Link href="/dashboard" aria-label="TaskCash Pro dashboard">
            <Logo size="sm" />
          </Link>
          <div className="flex items-center gap-2">
            <div className="rounded-xl border border-border bg-card px-3 py-1.5 text-right">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {user.currency}
              </p>
              <p className="text-sm font-bold leading-none">
                {formatMoney(user.availableBalance, user.currency, { compact: true })}
              </p>
            </div>
            <NotificationBell initialUnread={user.unread} />
          </div>
        </div>
      </header>

      {/* Desktop top bar */}
      <header className="sticky top-0 z-30 hidden h-16 items-center justify-end gap-3 border-b border-border bg-background/90 px-6 backdrop-blur-lg lg:flex">
        <Button asChild variant="outline" size="sm">
          <Link href="/dashboard/packages">Packages</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/dashboard/watch">Watch &amp; Earn</Link>
        </Button>
        <Button asChild size="sm">
          <Link href="/dashboard/withdraw">Withdraw</Link>
        </Button>
        <NotificationBell initialUnread={user.unread} />
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6 pb-28 lg:px-8 lg:pb-10">
        {children}
      </main>

      {/* ---------------------------------------------------------------- */}
      {/* Mobile bottom navigation (sticky, safe-area aware)               */}
      {/* ---------------------------------------------------------------- */}
      <nav
        aria-label="Bottom navigation"
        className="tc-safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur-lg lg:hidden"
      >
        <ul className="grid grid-cols-5">
          {PRIMARY_NAV.map((item) => {
            const active = isActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition-colors",
                    active ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  <Icon className={cn("h-5 w-5", active && "drop-shadow")} aria-hidden />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

function isActive(pathname: string, href: string) {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SidebarLink({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
        active
          ? "bg-primary/12 text-primary"
          : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      {label}
    </Link>
  );
}
