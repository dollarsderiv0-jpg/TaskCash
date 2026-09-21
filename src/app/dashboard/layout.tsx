import { guardPage, isAdminRole } from "@/lib/auth/guards";
import { countUnreadNotifications } from "@/server/services/notifications";
import { AppShell } from "@/components/app/app-shell";
import { AppInstallDetector } from "@/components/app/app-install-detector";

// Financial data must never be served from a cache.
export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Server-side guard: an unauthenticated visitor is redirected before any
  // financial data is loaded.
  const session = await guardPage();
  const unread = await countUnreadNotifications(session.profile.id);

  return (
    <AppShell
      user={{
        fullName: session.profile.full_name,
        email: session.profile.email,
        currency: session.wallet.currency,
        availableBalance: Number(session.wallet.available_balance),
        lockedBalance: Number(session.wallet.locked_balance),
        isAdmin: isAdminRole(session.profile.role),
        unread,
      }}
    >
      {/*
        Renders nothing. It watches for the page running inside the installed app
        and records that fact once, on whichever screen the user happens to open.
        Here rather than on one page, because a user who launches the app and goes
        straight to their wallet must still be recognised as an app user.
      */}
      <AppInstallDetector />
      {children}
    </AppShell>
  );
}
