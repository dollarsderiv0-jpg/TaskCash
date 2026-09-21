"use client";

import * as React from "react";
import { ExternalLink, FileCheck2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { COMPLIANCE_DOCUMENTS } from "@/content/compliance-documents";

/**
 * The "KRA" button below the dashboard slideshow, and the documents behind it.
 *
 * A client component for one reason: it opens a dialog. The documents themselves
 * are static files, so nothing here fetches anything — clicking the button shows
 * the scans that shipped with the app, and what a visitor sees cannot differ from
 * what was supplied.
 *
 * The dialog is where the label is explained. "KRA" on its own is the wording
 * that was asked for and is deliberately left alone on the button, but three
 * initials over two A4 scans explain nothing, so the panel names both documents,
 * says who issued them and links to the full-size file.
 *
 * Radix handles the accessibility here rather than a hand-rolled overlay: focus
 * moves into the panel and returns to the button on close, Escape closes it, the
 * background is inert while it is open, and `DialogTitle` gives it a name.
 */
export function ComplianceDocuments() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-center sm:w-auto">
          <FileCheck2 className="h-4 w-4" aria-hidden />
          KRA
          {/* Keeps the visible label intact while giving it a name that means something. */}
          <span className="sr-only"> — company registration documents</span>
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Company registration documents</DialogTitle>
          <DialogDescription>
            TASK CASH PRO LIMITED, as filed with the Registrar of Companies. Select a document to
            open the full-size scan.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {COMPLIANCE_DOCUMENTS.map((document) => (
            <figure key={document.file} className="space-y-2">
              {/*
                A plain <img>, like the other operator-supplied pictures in this app:
                these are scans of a fixed pixel size, and next/image would only add
                a resizing layer in front of two files that are already small (~60–85 KB).
                The container gives them a white surround so a scan never sits on the
                dialog's dark surface edge to edge.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={document.file}
                alt={document.alt}
                loading="lazy"
                decoding="async"
                className="w-full rounded-xl border border-border bg-white"
              />
              <figcaption className="space-y-1">
                <p className="text-sm font-semibold">{document.title}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{document.note}</p>
                <a
                  href={document.file}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-semibold text-primary underline-offset-4 hover:underline"
                >
                  Open full size
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              </figcaption>
            </figure>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
