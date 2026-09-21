"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/fields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, EmptyState, Separator } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";
import {
  AD_CATEGORIES,
  AD_CATEGORY_LABELS,
  AD_STATUSES,
  AD_STATUS_LABELS,
  adCategoryLabel,
  adStatusLabel,
  type Advertisement,
} from "@/lib/types";

type FormState = {
  id?: string;
  title: string;
  advertiser: string;
  imageUrl: string;
  linkUrl: string;
  altText: string;
  description: string;
  category: string;
  sortOrder: string;
  status: string;
  startsAt: string;
  endsAt: string;
};

const BLANK: FormState = {
  title: "",
  advertiser: "",
  imageUrl: "",
  linkUrl: "",
  altText: "",
  description: "",
  category: "COMPANY_REGISTRATION",
  sortOrder: "100",
  status: "DRAFT",
  startsAt: "",
  endsAt: "",
};

/** `<input type="datetime-local">` wants local wall-clock time, not an ISO instant. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromRow(ad: Advertisement): FormState {
  return {
    id: ad.id,
    title: ad.title,
    advertiser: ad.advertiser ?? "",
    imageUrl: ad.image_url,
    linkUrl: ad.link_url ?? "",
    altText: ad.alt_text ?? "",
    description: ad.description ?? "",
    category: ad.category,
    sortOrder: String(ad.sort_order),
    status: ad.status,
    startsAt: toLocalInput(ad.starts_at),
    endsAt: toLocalInput(ad.ends_at),
  };
}

export function AdsEditor({
  advertisements,
  available,
}: {
  advertisements: Advertisement[];
  available: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [form, setForm] = React.useState<FormState>(BLANK);
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function startCreate() {
    setForm(BLANK);
    setFields({});
    setFormError(null);
    setOpen(true);
  }

  function startEdit(ad: Advertisement) {
    setForm(fromRow(ad));
    setFields({});
    setFormError(null);
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    setFields({});
    setFormError(null);

    const result = await apiRequest<{ advertisement: { id: string } }>("/api/admin/ads", {
      method: "POST",
      body: {
        ...(form.id ? { id: form.id } : {}),
        title: form.title.trim(),
        advertiser: form.advertiser.trim() || null,
        imageUrl: form.imageUrl.trim(),
        linkUrl: form.linkUrl.trim() || null,
        altText: form.altText.trim() || null,
        description: form.description.trim() || null,
        category: form.category,
        sortOrder: Number(form.sortOrder || 0),
        status: form.status,
        // datetime-local has no timezone; toISOString() sends the real instant.
        startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null,
        endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
      },
    });

    setSaving(false);

    if (!result.ok) {
      setFields(result.fields ?? {});
      setFormError(result.message);
      toast({ title: "Could not save", description: result.message, tone: "error" });
      return;
    }

    toast({
      title: form.id ? "Advertisement saved" : "Advertisement created",
      description: form.id
        ? "The gallery updates on the next page load."
        : "It is saved as not published until you set it to Showing.",
      tone: "success",
    });
    setOpen(false);
    setForm(BLANK);
    router.refresh();
  }

  /** Flip status without opening the form — the common daily action. */
  async function setStatus(ad: Advertisement, status: string) {
    setBusyId(ad.id);
    const result = await apiRequest("/api/admin/ads", {
      method: "POST",
      body: {
        id: ad.id,
        title: ad.title,
        advertiser: ad.advertiser,
        imageUrl: ad.image_url,
        linkUrl: ad.link_url,
        altText: ad.alt_text,
        description: ad.description,
        category: ad.category,
        sortOrder: ad.sort_order,
        status,
        startsAt: ad.starts_at,
        endsAt: ad.ends_at,
      },
    });
    setBusyId(null);

    if (!result.ok) {
      toast({ title: "Could not update", description: result.message, tone: "error" });
      return;
    }

    toast({
      title: status === "ACTIVE" ? "Now showing" : "Hidden",
      description:
        status === "ACTIVE"
          ? "The advertisement appears in the gallery immediately."
          : "The advertisement is no longer shown to users.",
      tone: "success",
    });
    router.refresh();
  }

  async function remove(id: string) {
    setBusyId(id);
    const result = await apiRequest("/api/admin/ads", { method: "DELETE", body: { id } });
    setBusyId(null);
    setConfirmDelete(null);

    if (!result.ok) {
      toast({ title: "Could not remove", description: result.message, tone: "error" });
      return;
    }

    toast({ title: "Advertisement removed", tone: "success" });
    router.refresh();
  }

  return (
    <div className="space-y-5">
      <Alert variant="info" title="These are adverts, not rewards">
        <p>
          Viewing an advertisement pays nobody — there is no budget, no session and no ledger entry.
          Paid activities live under Videos &amp; campaigns. An advertisement is visible only while its
          status is <strong>Showing</strong> and the current time is inside its schedule window.
        </p>
      </Alert>

      {!available ? (
        <Alert variant="warning" title="Migration 0009 has not been applied">
          <p>
            The <code>advertisements</code> table does not exist in this database yet, so nothing can
            be published. Apply <code>supabase/migrations/0009_advertisements.sql</code> (or the
            regenerated <code>supabase/apply-all.sql</code>) and reload this page.
          </p>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {advertisements.length} advertisement{advertisements.length === 1 ? "" : "s"}
        </p>
        <Button onClick={startCreate} disabled={!available}>
          <Plus className="h-4 w-4" aria-hidden />
          New advertisement
        </Button>
      </div>

      {open ? (
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle>{form.id ? "Edit advertisement" : "New advertisement"}</CardTitle>
              <CardDescription>
                The image is loaded directly from its address, so it must be publicly reachable.
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} aria-label="Close">
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </CardHeader>

          <CardContent className="space-y-4">
            {formError ? (
              <Alert variant="destructive" title="Could not save">
                <p>{formError}</p>
              </Alert>
            ) : null}

            <Field label="Title" htmlFor="ad-title" error={fields.title}>
              <Input
                id="ad-title"
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
                placeholder="Register your company in 3 days"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Advertiser" htmlFor="ad-advertiser" error={fields.advertiser}>
                <Input
                  id="ad-advertiser"
                  value={form.advertiser}
                  onChange={(e) => set("advertiser", e.target.value)}
                  placeholder="Company name"
                />
              </Field>

              <Field label="Category" htmlFor="ad-category" error={fields.category}>
                <Select
                  id="ad-category"
                  value={form.category}
                  onChange={(e) => set("category", e.target.value)}
                >
                  {AD_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {AD_CATEGORY_LABELS[value]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field
              label="Image address"
              htmlFor="ad-image"
              error={fields.imageUrl}
              hint="A direct https:// link to the picture."
            >
              <Input
                id="ad-image"
                value={form.imageUrl}
                onChange={(e) => set("imageUrl", e.target.value)}
                placeholder="https://example.com/creative.png"
              />
            </Field>

            <Field
              label="Link (optional)"
              htmlFor="ad-link"
              error={fields.linkUrl}
              hint="Where a tap goes. Leave blank for a picture that is only informative."
            >
              <Input
                id="ad-link"
                value={form.linkUrl}
                onChange={(e) => set("linkUrl", e.target.value)}
                placeholder="https://example.com"
              />
            </Field>

            <Field
              label="Image description (optional)"
              htmlFor="ad-alt"
              error={fields.altText}
              hint="Read out by screen readers. If blank, the title is used, so the picture is never announced as nothing."
            >
              <Input
                id="ad-alt"
                value={form.altText}
                onChange={(e) => set("altText", e.target.value)}
                placeholder="A one-line description of the picture"
              />
            </Field>

            <Field label="Description (optional)" htmlFor="ad-description" error={fields.description}>
              <Textarea
                id="ad-description"
                rows={3}
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
              />
            </Field>

            <Separator />

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Status" htmlFor="ad-status" error={fields.status}>
                <Select id="ad-status" value={form.status} onChange={(e) => set("status", e.target.value)}>
                  {AD_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {AD_STATUS_LABELS[value]}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Order" htmlFor="ad-order" error={fields.sortOrder} hint="Lower shows first.">
                <Input
                  id="ad-order"
                  type="number"
                  min={0}
                  value={form.sortOrder}
                  onChange={(e) => set("sortOrder", e.target.value)}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Starts (optional)" htmlFor="ad-start" error={fields.startsAt}>
                <Input
                  id="ad-start"
                  type="datetime-local"
                  value={form.startsAt}
                  onChange={(e) => set("startsAt", e.target.value)}
                />
              </Field>

              <Field label="Ends (optional)" htmlFor="ad-end" error={fields.endsAt}>
                <Input
                  id="ad-end"
                  type="datetime-local"
                  value={form.endsAt}
                  onChange={(e) => set("endsAt", e.target.value)}
                />
              </Field>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={save} loading={saving}>
                {form.id ? "Save changes" : "Create advertisement"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {advertisements.length === 0 ? (
        <EmptyState
          title={available ? "No advertisements yet" : "Waiting for the migration"}
          description={
            available
              ? "Create the first one and it will appear in the gallery once its status is Showing."
              : "Once 0009 is applied, this screen manages the sponsored gallery."
          }
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>All advertisements</CardTitle>
            <CardDescription>Newest first is not used here — order is by the sort value.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {advertisements.map((ad) => (
              <div
                key={ad.id}
                className="flex flex-col gap-3 rounded-xl border border-border p-3 sm:flex-row sm:items-center"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- advertiser-hosted creative */}
                <img
                  src={ad.image_url}
                  alt={ad.alt_text?.trim() || ad.title}
                  loading="lazy"
                  className="h-20 w-full rounded-lg bg-secondary object-cover sm:w-32"
                />

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold">{ad.title}</p>
                    <Badge variant={ad.status === "ACTIVE" ? "success" : ad.status === "DRAFT" ? "outline" : "warning"}>
                      {adStatusLabel(ad.status)}
                    </Badge>
                    <Badge variant="outline">{adCategoryLabel(ad.category)}</Badge>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {ad.advertiser ?? "No advertiser named"} · order {ad.sort_order}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {ad.starts_at ? `from ${new Date(ad.starts_at).toLocaleDateString()}` : "from now"}
                    {ad.ends_at ? ` · until ${new Date(ad.ends_at).toLocaleDateString()}` : " · no end date"}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => startEdit(ad)} disabled={busyId === ad.id}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                    Edit
                  </Button>

                  {ad.status === "ACTIVE" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setStatus(ad, "PAUSED")}
                      loading={busyId === ad.id}
                    >
                      Pause
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => setStatus(ad, "ACTIVE")} loading={busyId === ad.id}>
                      Show
                    </Button>
                  )}

                  {confirmDelete === ad.id ? (
                    <>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => remove(ad.id)}
                        loading={busyId === ad.id}
                      >
                        Confirm
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmDelete(ad.id)}
                      aria-label={`Delete ${ad.title}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  )}

                  {ad.link_url ? (
                    <a
                      href={ad.link_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Open the advertiser's link"
                    >
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    </a>
                  ) : null}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
