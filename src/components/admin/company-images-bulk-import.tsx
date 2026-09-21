"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Images, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/fields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";

/**
 * Add a batch of company pictures in ONE submission.
 *
 * The single-picture form is still there for editing one entry's details, but a
 * sponsored-by strip is a dozen logos that all want the same treatment, and doing
 * that one at a time is a dozen uploads, a dozen saves and a dozen chances to
 * forget one. Here the operator selects them together, gives the batch one
 * caption, and posts once.
 *
 * What the batch does NOT ask for, on purpose:
 *
 *   · a name per picture — it comes from the file name (`netflix-logo.png` →
 *     `netflix logo`), because ten rows called "Company logo 1" are worse than
 *     ten rows named after the files the operator just chose;
 *   · a sort order — the order the files are listed in is the order they appear;
 *   · a status — a picture the operator just uploaded is meant to be visible.
 *
 * Order is reorderable afterwards in the list below, and every one of these is
 * editable there, so none of it is a decision made for good.
 *
 * A rejected file is reported beside the ones that succeeded rather than failing
 * the batch: an oversized logo should not mean choosing the other nine again.
 */

const MAX_FILES = 20;

type Failure = { fileName: string; reason: string };

export function CompanyImagesBulkImport({
  disabled,
  nextSortOrder,
}: {
  /** True while migration 0016 is missing — nothing can be saved. */
  disabled: boolean;
  /** Where a new batch's ordering should start, taken from the current list. */
  nextSortOrder: number;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [files, setFiles] = React.useState<File[]>([]);
  const [caption, setCaption] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [failures, setFailures] = React.useState<Failure[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  function choose(selected: FileList | null) {
    setError(null);
    setFailures([]);
    const list = Array.from(selected ?? []);
    if (list.length === 0) {
      setFiles([]);
      return;
    }
    if (list.length > MAX_FILES) {
      setError(`Add up to ${MAX_FILES} pictures at a time — you chose ${list.length}.`);
      setFiles([]);
      return;
    }
    setFiles(list);
  }

  async function upload() {
    if (files.length === 0) return;

    setBusy(true);
    setError(null);
    setFailures([]);

    try {
      const body = new FormData();
      for (const file of files) body.append("files", file);
      if (caption.trim().length > 0) body.append("caption", caption.trim());
      body.append("startSortOrder", String(nextSortOrder));

      // Plain fetch, not apiRequest: that helper sends JSON and a multipart body
      // must go out untouched so the browser sets its own boundary.
      const response = await fetch("/api/admin/company-images/bulk", {
        method: "POST",
        body,
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.ok) {
        const message = payload?.error?.message ?? "The pictures could not be uploaded. Try again.";
        setError(message);
        toast({ title: "Upload failed", description: message, tone: "error" });
        return;
      }

      const data = payload.data as {
        added: number;
        rejected: number;
        failed: Failure[];
        message: string;
      };

      setFailures(data.failed ?? []);
      setFiles([]);
      setCaption("");
      if (inputRef.current) inputRef.current.value = "";

      toast({
        title: data.added > 0 ? "Pictures added" : "Nothing was added",
        description: data.message,
        tone: data.added > 0 ? "success" : "error",
      });

      // The list and the slideshow are rendered on the server, so both are read
      // again rather than patched in the browser.
      if (data.added > 0) router.refresh();
    } catch {
      setError("The pictures could not be uploaded — the connection dropped.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add several at once</CardTitle>
        <CardDescription>
          Choose the company pictures together and they are published to the slideshow in one step.
          Each one is named after its file name — <code>netflix-logo.png</code> becomes{" "}
          <code>netflix logo</code> — and you can rename or reorder any of them below.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? (
          <Alert variant="destructive" title="Could not add them">
            <p>{error}</p>
          </Alert>
        ) : null}

        {failures.length > 0 ? (
          <Alert variant="warning" title={`${failures.length} picture(s) were not added`}>
            <ul className="space-y-1">
              {failures.map((failure) => (
                <li key={failure.fileName}>
                  <strong>{failure.fileName}</strong> — {failure.reason}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}

        <div className="rounded-xl border border-dashed border-border p-4 text-center">
          <Images className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden />
          <p className="mt-2 text-xs text-muted-foreground">
            PNG, JPEG or WebP, up to 2 MB each, {MAX_FILES} at a time. SVG is not accepted.
          </p>

          <label className="mt-3 inline-flex">
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              disabled={disabled || busy}
              onChange={(event) => choose(event.target.files)}
            />
            <span className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary/60">
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Images className="h-3.5 w-3.5" aria-hidden />
              )}
              {busy ? "Working…" : "Choose pictures"}
            </span>
          </label>

          {files.length > 0 ? (
            <ul className="mt-3 space-y-1 text-left text-xs text-muted-foreground">
              {files.map((file) => (
                <li key={file.name} className="truncate">
                  • {file.name}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <Field
          label="Caption for all of them (optional)"
          htmlFor="bulk-caption"
          hint="One short line under each picture, such as a sponsorship wording. Leave it empty for none."
        >
          <Input
            id="bulk-caption"
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="Sponsored by"
            maxLength={300}
            disabled={disabled || busy}
          />
        </Field>

        <Button onClick={upload} disabled={disabled || busy || files.length === 0} loading={busy}>
          <Upload className="h-4 w-4" aria-hidden />
          {files.length === 0
            ? "Add to slideshow"
            : `Add ${files.length} picture${files.length === 1 ? "" : "s"} to slideshow`}
        </Button>
      </CardContent>
    </Card>
  );
}
