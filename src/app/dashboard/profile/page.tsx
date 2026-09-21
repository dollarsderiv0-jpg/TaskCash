import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound, ShieldCheck, Smartphone } from "lucide-react";
import { guardPage } from "@/lib/auth/guards";
import { ProfileForm } from "@/components/app/profile-form";
import { RestartOnboarding } from "@/components/app/restart-onboarding";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, Separator, statusBadgeVariant } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { formatDate, formatDateTime } from "@/lib/money/format";
import { statusLabel } from "@/lib/types";
import { getPublicSettings } from "@/lib/settings";

export const metadata: Metadata = { title: "Profile" };

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = await guardPage();
  const settings = await getPublicSettings();
  const profile = session.profile;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Profile &amp; security</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your account details, verification status and security information.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Member since {formatDate(profile.created_at)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <ReadOnly label="Email address" value={profile.email} />
            <ReadOnly label="Country" value={profile.country} />
            <ReadOnly label="Currency" value={profile.currency} />
            <ReadOnly label="Referral code" value={profile.referral_code} mono />
          </div>

          <Separator />

          <div className="grid gap-4 sm:grid-cols-3">
            <StatusRow label="Account status" status={profile.status} />
            <StatusRow label="Verification" status={profile.kyc_status} />
            <StatusRow label="Account risk" status={profile.risk_status} />
          </div>

          {profile.risk_status !== "NORMAL" ? (
            <Alert variant="warning" title="Your account is under review">
              <p>
                Some activity on this account flagged for review. This does not mean you have done
                anything wrong — a member of our team will look at it. Earning or withdrawals may be
                paused until the review is complete.
              </p>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Editable details</CardTitle>
          <CardDescription>
            Email, currency, account status and verification status cannot be changed here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileForm
            fullName={profile.full_name}
            phone={profile.phone}
            country={profile.country}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Getting started</CardTitle>
          <CardDescription>
            The checklist on your dashboard can be hidden. Bring it back any time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RestartOnboarding />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-orangeBrand-500" aria-hidden />
            Security
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 text-sm sm:grid-cols-2">
            <ReadOnly
              label="Email confirmed"
              value={profile.email_verified_at ? formatDateTime(profile.email_verified_at) : "Not confirmed"}
            />
            <ReadOnly
              label="Last sign-in"
              value={profile.last_login_at ? formatDateTime(profile.last_login_at) : "—"}
            />
          </div>

          {settings.requireVerifiedKyc ? (
            <Alert variant="info" title="Verification required for withdrawals">
              <p>
                Withdrawals on this platform currently require a verified account. Your status is{" "}
                <strong>{statusLabel(profile.kyc_status)}</strong>.
              </p>
            </Alert>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/forgot-password">
                <KeyRound className="h-4 w-4" aria-hidden />
                Change password
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/notifications">
                <Smartphone className="h-4 w-4" aria-hidden />
                Notifications
              </Link>
            </Button>
          </div>

          <Separator />

          <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
            <p>
              Nobody from TaskCash Pro will ever ask for your password, a one-time code, or a fee to
              release earnings. If someone does, treat it as fraud and contact support.
            </p>
            <p>
              Your browser can never set a balance, a reward amount or a transaction status. All
              financial operations are performed on our servers and recorded in an immutable ledger.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <Link className="text-primary hover:underline" href="/terms">
          Terms
        </Link>
        <Link className="text-primary hover:underline" href="/privacy">
          Privacy
        </Link>
        <Link className="text-primary hover:underline" href="/withdrawal-policy">
          Withdrawal policy
        </Link>
        <Link className="text-primary hover:underline" href="/contact">
          Contact support
        </Link>
      </div>
    </div>
  );
}

function ReadOnly({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={mono ? "mt-1 font-mono text-sm" : "mt-1 text-sm font-medium"}>{value}</p>
    </div>
  );
}

function StatusRow({ label, status }: { label: string; status: string }) {
  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1.5">
        <Badge variant={statusBadgeVariant(status)}>{statusLabel(status)}</Badge>
      </div>
    </div>
  );
}
