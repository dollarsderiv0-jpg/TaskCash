"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, ImagePlus, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/fields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, EmptyState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";
import { CompanyImagesBulkImport } from "@/components/admin/company-images-bulk-import";
import {
  COMPANY_IMAGE_STATUSES,
  companyImageStatusLabel,
  type CompanyImage,
} from "@/lib/types";

/**
 * Manage the company pictures shown on the landing page and the dashboard.
 *
 * Two writes, deliberately separate. Uploading bytes goes to
 * `/api/admin/company-images/upload` and returns an address; SAVING the row goes
 * to `/api/admin/company-images` as JSON like every other admin form. That split
 * is why an upload the operator abandons leaves no row behind — the file is in the
 * bucket, the database knows nothing about it, and the section never shows a
 * picture nobody saved.
 *
 * `storagePath` is carried through the form for one reason: so that deleting the
 * row can also delete the object. A pasted external address has no path, because
 * this app never uploaded that file and must not pretend it can remove it.
 */

type FormState = {
  id?: string;
  name: string;
  caption: string;
  imageUrl: string;
  storagePath: string;
  linkUrl: string;
  sortOrder: string;
  status: string;
};

const BLANK: FormState = {
  name: "",
  caption: "",
  imageUrl: "",
  storagePath: "",
  linkUrl: "",
  sortOrder: "100",
  status: "ACTIVE",
};

function fromRow(image: CompanyImage): FormState {
  return {
    id: image.id,
    name: image.name,
    caption: image.caption ?? "",
    imageUrl: image.image_url,
    storagePath: image.storage_path ?? "",
    linkUrl: image.link_url ?? "",
    sortOrder: String(image.sort_order),
    status: image.status,
  };
}

export function CompanyImagesEditor({
  images,
  available,
}: {
  images: CompanyImage[];
  available: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [form, setForm] = React.useState<FormState>(BLANK);
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const set = (key: keyof FormState, value: string) => setForm((f) => ({ ...f, [key]: value }));

  function startCreate() {
    setForm(BLANK);
    setFields({});
    setFormError(null);
    setOpen(true);
  }

  function startEdit(image: CompanyImage) {
    setForm(fromRow(image));
    setFields({});
    setFormError(null);
    setOpen(true);
  }

  /**
   * Upload the chosen file and remember BOTH the public address and the bucket
   * path. The address is what the browser loads; the path is what a later delete
   * needs to remove the object.
   */
  async function handleFile(file: File) {
    setUploading(true);
    setFormError(null);

    try {
      const body = new FormData();
      body.append("file", file);

      // Plain fetch rather than apiRequest: that helper sends JSON, and a
      // multipart body must go out untouched so the browser can set its own
      // boundary in the Content-Type header.
      const response = await fetch("/api/admin/company-images/upload", {
        method: "POST",
        body,
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.ok) {
        const message =
          payload?.error?.message ?? "The picture could not be uploaded. Try again.";
        setFormError(message);
        toast({ title: "Upload failed", description: message, tone: "error" });
        return;
      }

      setForm((f) => ({
        ...f,
        imageUrl: payload.data.imageUrl as string,
        storagePath: payload.data.storagePath as string,
      }));
      toast({ title: "Picture uploaded", description: "Save to publish it." });
    } catch {
      setFormError("The picture could not be uploaded — the connection dropped.");
    } finally {
      setUploading(false);
      // Clear the input so choosing the same file twice still fires a change.
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function save() {
    setSaving(true);
    setFields({});
    setFormError(null);

    const result = await apiRequest<{ message: string }>("/api/admin/company-images", {
      method: "POST",
      body: {
        id: form.id,
        name: form.name,
        caption: form.caption,
        imageUrl: form.imageUrl,
        storagePath: form.storagePath,
        linkUrl: form.linkUrl,
        sortOrder: form.sortOrder,
        status: form.status,
      },
    });

    setSaving(false);

    if (!result.ok) {
      setFields(result.fields ?? {});
      setFormError(result.message);
      toast({ title: "Could not save", description: result.message, tone: "error" });
      return;
    }

    toast({ title: "Saved", description: result.data.message });
    setOpen(false);
    router.refresh();
  }

  /** Flip a picture between Showing and Hidden without opening the form. */
  async function setStatus(image: CompanyImage, status: string) {
    setBusyId(image.id);
    const result = await apiRequest<{ message: string }>("/api/admin/company-images", {
      method: "POST",
      body: {
        id: image.id,
        name: image.name,
        caption: image.caption,
        imageUrl: image.image_url,
        storagePath: image.storage_path,
        linkUrl: image.link_url,
        sortOrder: image.sort_order,
        status,
      },
    });
    setBusyId(null);

    if (!result.ok) {
      toast({ title: "Could not change it", description: result.message, tone: "error" });
      return;
    }
    toast({ title: status === "ACTIVE" ? "Now showing" : "Hidden" });
    router.refresh();
  }

  async function remove(image: CompanyImage) {
    setBusyId(image.id);
    const result = await apiRequest<{ message: string }>("/api/admin/company-images", {
      method: "DELETE",
      body: { id: image.id },
    });
    setBusyId(null);
    setConfirmDelete(null);

    if (!result.ok) {
      toast({ title: "Could not remove it", description: result.message, tone: "error" });
      return;
    }
    toast({ title: "Removed", description: result.data.message });
    router.refresh();
  }

  return (
    <div className="space-y-5">
      {!available ? (
        <Alert variant="warning" title="Waiting for the migration">
          <p>
            The <code>company_images</code> table does not exist on this database yet, so nothing
            here can be saved. Apply migration 0016 — the section stays hidden on the site until
            then rather than showing an empty frame.
          </p>
        </Alert>
      ) : null}

      {/*
        The batch form goes first: adding a sponsored-by strip is the common job
        here, and the single-picture form below is for editing what it produced.

        The starting order continues past the highest existing order so a new batch
        lands after the current pictures instead of interleaving with them.
      */}
      <CompanyImagesBulkImport
        disabled={!available}
        nextSortOrder={images.reduce((max, image) => Math.max(max, image.sort_order), 0) + 10}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {images.length} picture{images.length === 1 ? "" : "s"}
        </p>
        <Button onClick={startCreate} disabled={!available}>
          <Plus className="h-4 w-4" aria-hidden />
          Add picture
        </Button>
      </div>

      {open ? (
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle>{form.id ? "Edit picture" : "Add a picture"}</CardTitle>
              <CardDescription>
                This section appears on the home page and on the signed-in dashboard.
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

            {/* ---- the picture itself ------------------------------------ */}
            <div className="space-y-2">
              <p className="text-sm font-medium">Picture</p>

              {form.imageUrl ? (
                <div className="flex items-center gap-3 rounded-xl border border-border p-3">
                  {/* Operator-supplied art; the aspect box keeps the row steady. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={form.imageUrl}
                    alt=""
                    className="h-14 w-20 shrink-0 rounded-lg bg-secondary object-contain"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-muted-foreground">{form.imageUrl}</p>
                    {form.storagePath ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Stored in this project&apos;s image bucket.
                      </p>
                    ) : null}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setForm((f) => ({ ...f, imageUrl: "", storagePath: "" }))}
                  >
                    Replace
                  </Button>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-border p-4 text-center">
                  <ImagePlus className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden />
                  <p className="mt-2 text-xs text-muted-foreground">
                    PNG, JPEG or WebP, up to 2 MB. SVG is not accepted.
                  </p>
                  <label className="mt-3 inline-flex">
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="sr-only"
                      disabled={uploading}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void handleFile(file);
                      }}
                    />
                    <span className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary/60">
                      {uploading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      ) : (
                        <ImagePlus className="h-3.5 w-3.5" aria-hidden />
                      )}
                      {uploading ? "Uploading…" : "Choose a file"}
                    </span>
                  </label>
                </div>
              )}
            </div>

            <Field
              label="Picture address"
              htmlFor="image-url"
              error={fields.imageUrl}
              hint="Filled automatically when you upload. You can also paste an https:// address or a /path already served by this site."
            >
              <Input
                id="image-url"
                value={form.imageUrl}
                onChange={(e) => {
                  // Typing an address by hand means this app did NOT upload the
                  // file, so any remembered bucket path must be dropped — or a
                  // later delete would try to remove somebody else's object.
                  setForm((f) => ({ ...f, imageUrl: e.target.value, storagePath: "" }));
                }}
                placeholder="https://… or /companies/logo.png"
              />
            </Field>

            <Field label="Company name" htmlFor="image-name" error={fields.name}>
              <Input
                id="image-name"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Acme Ltd"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Caption (optional)"
                htmlFor="image-caption"
                error={fields.caption}
                hint="One short line under the name."
              >
                <Input
                  id="image-caption"
                  value={form.caption}
                  onChange={(e) => set("caption", e.target.value)}
                  placeholder="Sponsor"
                />
              </Field>

              <Field
                label="Link (optional)"
                htmlFor="image-link"
                error={fields.linkUrl}
                hint="An https:// address, or a /path on this site."
              >
                <Input
                  id="image-link"
                  value={form.linkUrl}
                  onChange={(e) => set("linkUrl", e.target.value)}
                  placeholder="https://acme.example"
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Order"
                htmlFor="image-order"
                error={fields.sortOrder}
                hint="Lower shows first."
              >
                <Input
                  id="image-order"
                  type="number"
                  min={0}
                  value={form.sortOrder}
                  onChange={(e) => set("sortOrder", e.target.value)}
                />
              </Field>

              <Field label="Status" htmlFor="image-status" error={fields.status}>
                <Select
                  id="image-status"
                  value={form.status}
                  onChange={(e) => set("status", e.target.value)}
                >
                  {COMPANY_IMAGE_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {companyImageStatusLabel(status)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={save} loading={saving} disabled={uploading}>
                {form.id ? "Save changes" : "Add picture"}
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {images.length === 0 ? (
        <EmptyState
          title={available ? "No pictures yet" : "Waiting for the migration"}
          description={
            available
              ? "Add the first one and it appears on the home page and the dashboard straight away."
              : "Once 0016 is applied, this screen manages the company pictures."
          }
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>All pictures</CardTitle>
            <CardDescription>Ordered by the sort value, lowest first.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {images.map((image) => (
              <div
                key={image.id}
                className="flex flex-col gap-3 rounded-xl border border-border p-3 sm:flex-row sm:items-center"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.image_url}
                  alt={image.name}
                  loading="lazy"
                  className="h-16 w-full rounded-lg bg-secondary object-contain sm:w-24"
                />

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold">{image.name}</p>
                    <Badge variant={image.status === "ACTIVE" ? "success" : "outline"}>
                      {companyImageStatusLabel(image.status)}
                    </Badge>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {image.caption ?? "No caption"} · order {image.sort_order}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {image.link_url ?? "No link"}
                    {image.storage_path ? " · uploaded here" : " · external address"}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => startEdit(image)}
                    disabled={busyId === image.id}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                    Edit
                  </Button>

                  {image.status === "ACTIVE" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setStatus(image, "HIDDEN")}
                      disabled={busyId === image.id}
                    >
                      <EyeOff className="h-3.5 w-3.5" aria-hidden />
                      Hide
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setStatus(image, "ACTIVE")}
                      disabled={busyId === image.id}
                    >
                      <Eye className="h-3.5 w-3.5" aria-hidden />
                      Show
                    </Button>
                  )}

                  {confirmDelete === image.id ? (
                    <>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => remove(image)}
                        disabled={busyId === image.id}
                      >
                        Confirm
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmDelete(image.id)}
                      disabled={busyId === image.id}
                      aria-label={`Remove ${image.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
