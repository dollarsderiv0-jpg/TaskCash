import { requireAdmin } from "@/lib/auth/guards";
import { listSettings } from "@/lib/settings";
import { SettingsEditor } from "@/components/admin/settings-editor";
import { Alert } from "@/components/ui/misc";

export const dynamic = "force-dynamic";

type SettingRow = {
  key: string;
  value: unknown;
  type: string;
  category: string;
  description: string | null;
  is_public: boolean;
};

export default async function AdminSettingsPage() {
  await requireAdmin();
  const settings = (await listSettings()) as SettingRow[];

  const identityConfigured = settings.some(
    (row) => row.key === "platform.support_email" && typeof row.value === "string" && row.value.trim(),
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Business rules, payment configuration and the operator details published on the public
          site.
        </p>
      </div>

      {!identityConfigured ? (
        <Alert variant="warning" title="Publish your operator details">
          <p>
            The public site currently states that operator details have not been supplied. Fill in the{" "}
            <code className="font-mono text-xs">legal</code> group below — legal entity name,
            registration details, business address and support contacts — so the site can name who
            actually operates it. We deliberately do not invent these values.
          </p>
        </Alert>
      ) : null}

      <SettingsEditor settings={settings} />
    </div>
  );
}
