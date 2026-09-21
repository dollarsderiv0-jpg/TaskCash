"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckSquare,
  PackagePlus,
  Pencil,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/fields";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, EmptyState, Separator } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";
import { formatMoney } from "@/lib/money/format";
import {
  PACKAGE_STATUSES,
  packageStatusLabel,
  type PackageStatus,
  type PackageWithUsage,
} from "@/lib/types";

/**
 * Admin packages editor.
 *
 * Two rules this screen makes visible rather than leaving to a failed save:
 *
 *   · A package with no daily earning limit CANNOT be sold — the database
 *     refuses it (PACKAGE_NOT_AVAILABLE). The row says so, so nobody publishes a
 *     tier that takes money and pays nothing.
 *   · A video can belong to one package only. Videos already attached elsewhere
 *     are shown as unavailable for this tier rather than being silently stolen
 *     from the other one.
 *
 * Money moved by a purchase is never edited here: changing a tier's cap or price
 * affects future purchases only. Users who already bought it keep the snapshot
 * they paid for, which is enforced in the database.
 */

type AdminTier = PackageWithUsage & { holders?: number };

type VideoOption = {
  id: string;
  title: string;
  status: string;
  rewardAmount: number;
  packagedBy: string | null;
};

type FormState = {
  id?: string;
  name: string;
  description: string;
  price: string;
  currency: string;
  dailyEarningCap: string;
  /** Empty means no lifetime ceiling — a blank field, not a zero. */
  lifetimeEarningCap: string;
  /** Empty means the purchase never lapses. */
  durationDays: string;
  status: PackageStatus;
  sortOrder: string;
  videoIds: string[];
};

const BLANK: FormState = {
  name: "",
  description: "",
  price: "",
  currency: "KES",
  dailyEarningCap: "",
  lifetimeEarningCap: "",
  durationDays: "",
  status: "DRAFT",
  sortOrder: "100",
  videoIds: [],
};

function VideoPicker({
  videos,
  tierId,
  selected,
  onChange,
}: {
  videos: VideoOption[];
  tierId?: string;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = React.useState("");

  const selectedSet = React.useMemo(() => new Set(selected), [selected]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? videos.filter((v) => v.title.toLowerCase().includes(q)) : videos;
    return list.slice(0, 200);
  }, [query, videos]);

  function toggle(id: string) {
    onChange(selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }

  return (
    <div className="space-y-3">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search videos by title…"
        aria-label="Search videos"
      />

      <div className="max-h-72 overflow-y-auto rounded-xl border border-border">
        {filtered.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No videos match that search.</p>
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((video) => {
              const attachedHere = selectedSet.has(video.id);
              // Attached to a DIFFERENT package: not selectable, and the reason
              // is shown instead of failing later with a unique violation.
              const elsewhere = video.packagedBy !== null && video.packagedBy !== tierId;
              const rowId = `video-${video.id}`;

              return (
                <li key={video.id} className="flex items-start gap-3 p-3">
                  <input
                    id={rowId}
                    type="checkbox"
                    className="sr-only"
                    checked={attachedHere}
                    disabled={elsewhere}
                    onChange={() => toggle(video.id)}
                  />
                  <button
                    type="button"
                    onClick={() => !elsewhere && toggle(video.id)}
                    disabled={elsewhere}
                    aria-pressed={attachedHere}
                    aria-label={`${attachedHere ? "Remove" : "Add"} ${video.title}`}
                    className="mt-0.5 shrink-0 text-primary disabled:cursor-not-allowed disabled:text-muted-foreground"
                  >
                    {attachedHere ? (
                      <CheckSquare className="h-4 w-4" aria-hidden />
                    ) : (
                      <Square className="h-4 w-4" aria-hidden />
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{video.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {video.status} · reward {formatMoney(video.rewardAmount, "KES")}
                      {elsewhere ? " · already in another package" : ""}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {selected.length} video{selected.length === 1 ? "" : "s"} attached. Showing up to 200
        matches — search to narrow the list.
      </p>
    </div>
  );
}

export function PackagesEditor({
  packages: tiers,
  videoIds,
  videos,
  available,
}: {
  packages: AdminTier[];
  videoIds: Record<string, string[]>;
  videos: VideoOption[];
  available: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [form, setForm] = React.useState<FormState | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<AdminTier | null>(null);

  const capValue = form ? Number(form.dailyEarningCap || 0) : 0;

  function openNew() {
    setError(null);
    setForm({ ...BLANK });
  }

  function openEdit(tier: AdminTier) {
    setError(null);
    setForm({
      id: tier.id,
      name: tier.name,
      description: tier.description ?? "",
      price: String(tier.price),
      currency: tier.currency,
      dailyEarningCap: String(tier.daily_earning_cap),
      lifetimeEarningCap:
        tier.lifetime_earning_cap === null || tier.lifetime_earning_cap === undefined
          ? ""
          : String(tier.lifetime_earning_cap),
      durationDays:
        tier.duration_days === null || tier.duration_days === undefined
          ? ""
          : String(tier.duration_days),
      status: tier.status,
      sortOrder: String(tier.sort_order),
      videoIds: videoIds[tier.id] ?? [],
    });
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;

    setLoading(true);
    setError(null);

    const response = await apiRequest<{ message: string }>("/api/admin/packages", {
      method: "POST",
      body: {
        id: form.id,
        name: form.name,
        description: form.description || null,
        price: Number(form.price),
        currency: form.currency,
        dailyEarningCap: Number(form.dailyEarningCap || 0),
        /*
          Blank means null, and null is not zero: no ceiling and no expiry, rather
          than a package allowed to pay nothing or one that lapses immediately. The
          database rejects a 0 in either column for exactly this reason.
        */
        lifetimeEarningCap: form.lifetimeEarningCap.trim() === "" ? null : Number(form.lifetimeEarningCap),
        durationDays: form.durationDays.trim() === "" ? null : Number(form.durationDays),
        status: form.status,
        sortOrder: Number(form.sortOrder || 100),
        videoIds: form.videoIds,
      },
    });

    setLoading(false);

    if (!response.ok) {
      setError(response.message);
      return;
    }

    toast({ title: "Package saved", description: response.data.message, tone: "success" });
    setForm(null);
    router.refresh();
  }

  async function remove(tier: AdminTier) {
    setLoading(true);

    const response = await apiRequest<{ message: string }>("/api/admin/packages", {
      method: "DELETE",
      body: { id: tier.id },
    });

    setLoading(false);

    if (!response.ok) {
      toast({ title: "Could not remove package", description: response.message, tone: "error" });
      setConfirmDelete(null);
      return;
    }

    toast({ title: "Package removed", tone: "success" });
    setConfirmDelete(null);
    router.refresh();
  }

  if (!available) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Packages are not set up on this database yet"
        description="Migration 0014 has not been applied, so the packages table does not exist. Apply the outstanding migrations, then reload this page."
      />
    );
  }

  const sellable = tiers.filter((t) => t.status === "ACTIVE" && t.daily_earning_cap > 0);

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Packages
          </p>
          <p className="mt-1 text-xl font-bold tracking-tight">{tiers.length}</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            On sale
          </p>
          <p className="mt-1 text-xl font-bold tracking-tight">{sellable.length}</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Active purchases
          </p>
          <p className="mt-1 text-xl font-bold tracking-tight">
            {tiers.reduce((sum, tier) => sum + (tier.holders ?? 0), 0)}
          </p>
        </div>
      </div>

      {tiers.some((t) => t.status === "ACTIVE" && t.daily_earning_cap <= 0) ? (
        <Alert variant="warning" title="An active package has no daily earning limit">
          <p>
            The database refuses to sell a package whose daily earning limit is zero, because it
            would take the user&apos;s money and pay nothing. Set a limit or move it back to Draft.
          </p>
        </Alert>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">All packages</h2>
        <Button onClick={openNew} disabled={form !== null}>
          <PackagePlus className="h-4 w-4" aria-hidden />
          New package
        </Button>
      </div>

      {form ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>{form.id ? "Edit package" : "New package"}</CardTitle>
            <Button variant="ghost" size="icon" onClick={() => setForm(null)} aria-label="Close">
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </CardHeader>
          <CardContent>
            <form onSubmit={save} className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" htmlFor="pkgName">
                  <Input
                    id="pkgName"
                    required
                    minLength={2}
                    maxLength={120}
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </Field>
                <Field label="Price" htmlFor="pkgPrice" hint="Paid once, from the user's wallet.">
                  <Input
                    id="pkgPrice"
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    value={form.price}
                    onChange={(e) => setForm({ ...form, price: e.target.value })}
                  />
                </Field>
                <Field
                  label="Daily earning limit"
                  htmlFor="pkgCap"
                  hint="The most this package can pay one user in a day. Zero means it cannot be sold."
                >
                  <Input
                    id="pkgCap"
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    value={form.dailyEarningCap}
                    onChange={(e) => setForm({ ...form, dailyEarningCap: e.target.value })}
                  />
                </Field>
                <Field
                  label="Total earning limit"
                  htmlFor="pkgTotal"
                  hint="The most one purchase can ever pay. Leave blank for no ceiling."
                >
                  <Input
                    id="pkgTotal"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={form.lifetimeEarningCap}
                    onChange={(e) => setForm({ ...form, lifetimeEarningCap: e.target.value })}
                  />
                </Field>
                <Field
                  label="Earning period (days)"
                  htmlFor="pkgDays"
                  hint="How long a purchase keeps earning. Leave blank for no end date."
                >
                  <Input
                    id="pkgDays"
                    type="number"
                    min="1"
                    step="1"
                    value={form.durationDays}
                    onChange={(e) => setForm({ ...form, durationDays: e.target.value })}
                  />
                </Field>
                <Field label="Currency" htmlFor="pkgCurrency">
                  <Input
                    id="pkgCurrency"
                    required
                    maxLength={3}
                    value={form.currency}
                    onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
                  />
                </Field>
                <Field label="Status" htmlFor="pkgStatus">
                  <Select
                    id="pkgStatus"
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value as PackageStatus })}
                  >
                    {PACKAGE_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {packageStatusLabel(status)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Sort order" htmlFor="pkgSort" hint="Lower shows first.">
                  <Input
                    id="pkgSort"
                    type="number"
                    min="0"
                    value={form.sortOrder}
                    onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                  />
                </Field>
              </div>

              <Field label="Description" htmlFor="pkgDescription">
                <Textarea
                  id="pkgDescription"
                  rows={2}
                  maxLength={2000}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </Field>

              {form.status === "ACTIVE" && capValue <= 0 ? (
                <Alert variant="warning" title="This package will not be sellable">
                  <p>
                    A daily earning limit of zero makes the package unavailable for purchase, so
                    users will see it as &quot;not on sale yet&quot;.
                  </p>
                </Alert>
              ) : null}

              {/*
                Both ceilings and the period are what a buyer is told on the packages
                page, so a tier is worth a warning when only some of them are set: a
                lifetime ceiling with no period never ends, and a period with no
                lifetime ceiling can pay for the whole term with nothing bounding it.
              */}
              {form.status === "ACTIVE" && capValue > 0 && (form.lifetimeEarningCap.trim() === "") !== (form.durationDays.trim() === "") ? (
                <Alert variant="warning" title="Half a term">
                  <p>
                    This tier has only one of a total earning limit and an earning period. Set
                    both so the packages page can state what the purchase is limited to, or
                    neither if the tier is genuinely open-ended.
                  </p>
                </Alert>
              ) : null}

              <Separator />

              <div>
                <p className="text-sm font-semibold">Videos in this package</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  A video belongs to one package at a time.
                </p>
                <div className="mt-3">
                  <VideoPicker
                    videos={videos}
                    tierId={form.id}
                    selected={form.videoIds}
                    onChange={(next) => setForm({ ...form, videoIds: next })}
                  />
                </div>
              </div>

              {error ? (
                <p className="text-sm font-medium text-destructive" role="alert">
                  {error}
                </p>
              ) : null}

              <div className="flex gap-3">
                <Button type="submit" loading={loading}>
                  Save package
                </Button>
                <Button type="button" variant="outline" onClick={() => setForm(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {tiers.length === 0 ? (
        <EmptyState
          icon={PackagePlus}
          title="No packages yet"
          description="Create a package, set its daily earning limit, then attach the videos it unlocks."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Package</th>
                    <th className="px-4 py-3 font-semibold">Price</th>
                    <th className="px-4 py-3 font-semibold">Daily limit</th>
                    <th className="px-4 py-3 font-semibold">Videos</th>
                    <th className="px-4 py-3 font-semibold">Holders</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {tiers.map((tier) => (
                    <tr key={tier.id}>
                      <td className="px-4 py-3">
                        <p className="font-medium">{tier.name}</p>
                        {tier.description ? (
                          <p className="mt-0.5 max-w-md truncate text-xs text-muted-foreground">
                            {tier.description}
                          </p>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {formatMoney(tier.price, tier.currency)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {tier.daily_earning_cap > 0
                          ? formatMoney(tier.daily_earning_cap, tier.currency)
                          : "—"}
                      </td>
                      <td className="px-4 py-3">{tier.videoCount}</td>
                      <td className="px-4 py-3">{tier.holders ?? 0}</td>
                      <td className="px-4 py-3">
                        <Badge variant={tier.status === "ACTIVE" ? "success" : "default"}>
                          {packageStatusLabel(tier.status)}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="sm" onClick={() => openEdit(tier)}>
                            <Pencil className="h-3.5 w-3.5" aria-hidden />
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => setConfirmDelete(tier)}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                            Remove
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {confirmDelete ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">
              Remove &quot;{confirmDelete.name}&quot;?
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/*
              Confirmation for a consequential action, and the consequence is
              stated before it happens rather than after: the delete is refused
              outright once anyone has bought the tier.
            */}
            {confirmDelete.holders && confirmDelete.holders > 0 ? (
              <Alert variant="warning" title="This package has active purchases">
                <p>
                  {confirmDelete.holders} user
                  {confirmDelete.holders === 1 ? " holds" : "s hold"} this package, so the database
                  will refuse to delete it. Archive it instead — existing purchases keep the terms
                  they bought.
                </p>
              </Alert>
            ) : (
              <p className="text-sm text-muted-foreground">
                This removes the package and its video attachments. Ledger history is never deleted,
                so any past purchase remains in the audit trail.
              </p>
            )}

            <div className="flex gap-3">
              <Button
                variant="destructive"
                loading={loading}
                onClick={() => remove(confirmDelete)}
                disabled={Boolean(confirmDelete.holders && confirmDelete.holders > 0)}
              >
                Remove package
              </Button>
              <Button variant="outline" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
