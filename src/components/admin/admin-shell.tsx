"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowLeft,
  BookOpenCheck,
  Building2,
  FileBarChart,
  Gift,
  Images,
  LifeBuoy,
  ListChecks,
  LogOut,
  Megaphone,
  Menu,
  Package as PackageIcon,
  Scale,
  Settings,
  ShieldCheck,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { cn, initials } from "@/lib/utils";

const NAV = [
  { href: "/admin", label: "Overview", icon: FileBarChart },
  { href: "/admin/withdrawals", label: "Withdrawals", icon: Wallet },
  { href: "/admin/deposits", label: "Deposits", icon: ArrowLeftRight },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/transactions", label: "Transactions", icon: BookOpenCheck },
  { href: "/admin/referrals", label: "Referrals", icon: ListChecks },
  { href: "/admin/videos", label: "Videos & Campaigns", icon: Building2 },
  { href: "/admin/packages", label: "Packages", icon: PackageIcon },
  { href: "/admin/ads", label: "Advertisements", icon: Megaphone },
  { href: "/admin/company-images", label: "Company images", icon: Images },
  { href: "/admin/redeem-codes", label: "Redeem Codes", icon: Gift },
  { href: "/admin/groups", label: "WhatsApp Groups", icon: Users },
  { href: "/admin/fraud", label: "Fraud review", icon: AlertTriangle },
  { href: "/admin/support", label: "Support requests", icon: LifeBuoy },
  { href: "/admin/reconciliation", label: "Reconciliation", icon: Scale },
  { href: "/admin/reports", label: "Reports", icon: FileBarChart },
  { href: "/admin/audit-logs", label: "Audit logs", icon: ShieldCheck },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

export function AdminShell({
  admin,
  children,
}: {
  admin: { fullName: string; email: string; role: string };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => setOpen(false), [pathname]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  const nav = (
    <nav aria-label="Admin" className="space-y-1">
      {NAV.map((item) => {
        const active = item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
              active
                ? "bg-primary/12 text-primary"
                : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-dvh bg-background lg:pl-72">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-72 flex-col border-r border-border bg-card/50 lg:flex">
        <div className="flex h-16 items-center justify-between px-5">
          <Link href="/admin" aria-label="TaskCash Pro admin">
            <Logo size="sm" />
          </Link>
          <Badge variant="warning">Admin</Badge>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-4">{nav}</div>

        <div className="border-t border-border p-3">
          <div className="flex items-center gap-3 rounded-xl px-2 py-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-xs font-semibold">
              {initials(admin.fullName) || "AD"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{admin.fullName}</p>
              <p className="truncate text-xs text-muted-foreground">{admin.role}</p>
            </div>
          </div>
          <Button
            variant="ghost"
            className="mt-1 w-full justify-start gap-3 px-2 text-muted-foreground"
            onClick={logout}
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Sign out
          </Button>
          <Button asChild variant="ghost" className="w-full justify-start gap-3 px-2 text-muted-foreground">
            <Link href="/dashboard">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to app
            </Link>
          </Button>
        </div>
      </aside>

      {/* Mobile header */}
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border bg-background/90 px-4 backdrop-blur-lg lg:hidden">
        <Link href="/admin" aria-label="TaskCash Pro admin">
          <Logo size="sm" />
        </Link>
        <div className="flex items-center gap-2">
          <Badge variant="warning">Admin</Badge>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg hover:bg-secondary"
            aria-expanded={open}
            aria-label={open ? "Close navigation" : "Open navigation"}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </header>

      {open ? (
        <div className="border-b border-border bg-card px-4 py-3 lg:hidden">{nav}</div>
      ) : null}

      <main id="main" className="mx-auto w-full max-w-7xl px-4 py-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
