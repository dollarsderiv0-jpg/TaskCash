"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Textarea } from "@/components/ui/fields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";

type SettingRow = {
  key: string;
  value: unknown;
  type: string;
  category: string;
  description: string | null;
  is_public: boolean;
};

/**
 * Settings editor.
 *
 * Money-affecting values are also read inside the Postgres money functions, so
 * a change here applies to the very next financial operation rather than being
 * a UI-only hint. Values are sent as their real type, not as strings.
 */
export function SettingsEditor({ settings }: { settings: SettingRow[] }) {
  const router = useRouter();
  const { toast } = useToast();

  const [draft, setDraft] = React.useState<Record<string, unknown>>(() =>
    Object.fromEntries(settings.map((row) => [row.key, row.value])),
  );
  const [dirty, setDirty] = React.useState<Set<string>>(new Set());
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const categories = React.useMemo(() => {
    const map = new Map<string, SettingRow[]>();
    for (const row of settings) {
      const list = map.get(row.category) ?? [];
      list.push(row);
      map.set(row.category, list);
    }
    return Array.from(map.entries());
  }, [settings]);

  function update(key: string, value: unknown) {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty((current) => new Set(current).add(key));
  }

  function coerce(row: SettingRow, raw: string) {
    if (row.type === "number") {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : raw;
    }
    if (row.type === "json") {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    return raw;
  }

  async function save() {
    setSaving(true);
    setError(null);

    const updates = Array.from(dirty).map((key) => ({ key, value: draft[key] ?? null }));

    const response = await apiRequest<{ message: string }>("/api/admin/settings", {
      method: "PATCH",
      body: { updates },
    });

    setSaving(false);

    if (!response.ok) {
      setError(response.message);
      return;
    }

    toast({ title: "Settings saved", description: response.data.message, tone: "success" });
    setDirty(new Set());
    router.refresh();
  }

  return (
    <div className="space-y-5">
      <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-background/95 p-3 backdrop-blur">
        <p className="text-sm text-muted-foreground">
          {dirty.size > 0
            ? `${dirty.size} unsaved change${dirty.size === 1 ? "" : "s"}`
            : "All changes saved"}
        </p>
        <Button onClick={() => void save()} loading={saving} disabled={dirty.size === 0}>
          <Save className="h-4 w-4" aria-hidden />
          Save changes
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive" title="Could not save settings">
          <p>{error}</p>
        </Alert>
      ) : null}

      <Alert variant="info" title="These values are authoritative">
        <p>
          Reward limits, withdrawal limits and referral rates are re-read inside the database during
          each financial operation, so what you set here is what the platform enforces.
        </p>
      </Alert>

      {categories.map(([category, rows]) => (
        <Card key={category}>
          <CardHeader>
            <CardTitle className="capitalize">{category}</CardTitle>
            <CardDescription>{rows.length} setting(s) in this group.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {rows.map((row) => {
              const value = draft[row.key];

              return (
                <div key={row.key} className="border-b border-border pb-5 last:border-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-xs">{row.key}</code>
                    <Badge variant="default">{row.type}</Badge>
                    {row.is_public ? <Badge variant="info">Shown publicly</Badge> : null}
                    {dirty.has(row.key) ? <Badge variant="warning">Modified</Badge> : null}
                  </div>

                  {row.description ? (
                    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                      {row.description}
                    </p>
                  ) : null}

                  <div className="mt-3 max-w-xl">
                    {row.type === "boolean" ? (
                      <label className="flex items-center gap-3 text-sm">
                        <Checkbox
                          checked={value === true || value === "true"}
                          onCheckedChange={(checked) => update(row.key, checked === true)}
                        />
                        <span className="text-muted-foreground">
                          {value === true || value === "true" ? "Enabled" : "Disabled"}
                        </span>
                      </label>
                    ) : row.type === "json" ? (
                      <Textarea
                        value={
                          typeof value === "string" ? value : JSON.stringify(value, null, 2)
                        }
                        onChange={(e) => update(row.key, coerce(row, e.target.value))}
                        className="font-mono text-xs"
                        aria-label={row.key}
                      />
                    ) : (
                      <Input
                        type={row.type === "number" ? "number" : "text"}
                        step={row.type === "number" ? "any" : undefined}
                        value={value === null || value === undefined ? "" : String(value ?? "")}
                        onChange={(e) => update(row.key, coerce(row, e.target.value))}
                        aria-label={row.key}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
