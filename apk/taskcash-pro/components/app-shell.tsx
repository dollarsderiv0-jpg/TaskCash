"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/format";
import { useStore } from "@/lib/store";
import { Header } from "./header";
import { MobileNav } from "./mobile-nav";
import { Sidebar } from "./sidebar";

/**
 * Every signed-in screen renders inside this shell.
 *
 * The `ready` gate matters: without it the guard would run before localStorage
 * has been read and bounce a signed-in user to the login screen on refresh.
 */
export function AppShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { ready, authed } = useStore();
  const router = useRouter();

  React.useEffect(() => {
    if (ready && !authed) router.replace("/login");
  }, [ready, authed, router]);

  if (!ready || !authed) return <ShellSkeleton />;

  return (
    <div className="min-h-screen">
      <Sidebar />
      <div className="lg:pl-[236px]">
        <Header />
        <main
          className={cn(
            /* Bottom padding clears the fixed tab bar on mobile. */
            "mx-auto w-full max-w-[1120px] px-4 pb-28 pt-4 sm:px-6 sm:pt-5 lg:pb-12",
            className,
          )}
        >
          {children}
        </main>
      </div>
      <MobileNav />
    </div>
  );
}

/** Shown for the one frame before storage is read. */
function ShellSkeleton() {
  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-[1120px] px-4 pt-6 sm:px-6">
        <div className="h-6 w-40 animate-pulse rounded-md bg-white/5" />
        <div className="mt-5 h-28 animate-pulse rounded-card bg-white/[0.04]" />
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-20 animate-pulse rounded-card bg-white/[0.04]" />
          ))}
        </div>
        <p className="mt-6 text-center text-xs text-muted">Loading your dashboard…</p>
      </div>
    </div>
  );
}
