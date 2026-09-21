import type { Metadata } from "next";
import { Smartphone, CheckCircle2, Info, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { guardPage } from "@/lib/auth/guards";
import { AppInstallButton } from "@/components/app/app-install-button";
import { AppInstallDetector } from "@/components/app/app-install-detector";

export const metadata: Metadata = { title: "Install TaskCash Pro" };

export default async function InstallPage() {
  const session = await guardPage();
  const installed = Boolean(session.profile.app_downloaded_at);

  return (
    <div className="mx-auto max-w-lg space-y-6 px-4 py-8">
      {/* Watches for a standalone launch, so opening the app is enough to record it. */}
      <AppInstallDetector />

      <div>
        <h1 className="text-2xl font-bold tracking-tight">Install TaskCash Pro</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Add TaskCash Pro to your home screen for quick access.
        </p>
      </div>

      {/*
        The confirmation that ties the install to the account. Placed first,
        because it is the one thing on this page that changes what the app shows
        the user — the wallet screen reveals their withdrawal limits once the app
        is on their device.
      */}
      <div className="rounded-2xl border border-primary/30 bg-primary/10 p-5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold">Link this device to your account</h2>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Your withdrawal limits are shown inside the app, on the wallet screen. Install it,
          then confirm below — or simply open it from your home screen and it is recorded
          automatically.
        </p>
        <div className="mt-3">
          <AppInstallButton installed={installed} />
        </div>
      </div>


      {/* Android Chrome */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orangeBrand-500/12">
            <Smartphone className="h-5 w-5 text-orangeBrand-500" />
          </div>
          <div>
            <p className="font-semibold">Android (Chrome)</p>
            <p className="text-xs text-muted-foreground">Best experience on Android phones</p>
          </div>
        </div>
        <ol className="mt-3 space-y-2 text-sm text-muted-foreground">
          <li className="flex gap-2">
            <span className="font-bold text-orangeBrand-500">1.</span>
            Open this page in Chrome on your Android phone.
          </li>
          <li className="flex gap-2">
            <span className="font-bold text-orangeBrand-500">2.</span>
            Tap the three-dot menu (⋮) in the top-right corner.
          </li>
          <li className="flex gap-2">
            <span className="font-bold text-orangeBrand-500">3.</span>
            Tap &quot;Add to Home screen&quot; or &quot;Install app&quot;.
          </li>
          <li className="flex gap-2">
            <span className="font-bold text-orangeBrand-500">4.</span>
            Confirm by tapping &quot;Install&quot;.
          </li>
        </ol>
        <p className="mt-3 text-xs text-muted-foreground flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          TaskCash Pro will appear on your home screen like a native app.
        </p>
      </div>

      {/* iPhone Safari */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orangeBrand-500/12">
            <Smartphone className="h-5 w-5 text-orangeBrand-500" />
          </div>
          <div>
            <p className="font-semibold">iPhone (Safari)</p>
            <p className="text-xs text-muted-foreground">Works on iPhone with Safari</p>
          </div>
        </div>
        <ol className="mt-3 space-y-2 text-sm text-muted-foreground">
          <li className="flex gap-2">
            <span className="font-bold text-orangeBrand-500">1.</span>
            Open this page in Safari on your iPhone.
          </li>
          <li className="flex gap-2">
            <span className="font-bold text-orangeBrand-500">2.</span>
            Tap the Share button (rectangle with arrow) at the bottom.
          </li>
          <li className="flex gap-2">
            <span className="font-bold text-orangeBrand-500">3.</span>
            Scroll down and tap &quot;Add to Home Screen&quot;.
          </li>
          <li className="flex gap-2">
            <span className="font-bold text-orangeBrand-500">4.</span>
            Tap &quot;Add&quot; in the top-right corner.
          </li>
        </ol>
      </div>

      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Why install?</h2>
        </div>
        <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
          <li>• Quick access from your home screen</li>
          <li>• No need to open a browser each time</li>
          <li>• Works just like a native app</li>
          <li>• Get notified when rewards are added</li>
        </ul>
      </div>

      <Link
        href="/dashboard"
        className="block text-center text-sm font-medium text-orangeBrand-500 hover:underline"
      >
        ← Back to Dashboard
      </Link>
    </div>
  );
}
