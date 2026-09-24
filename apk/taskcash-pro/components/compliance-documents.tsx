"use client";

import * as React from "react";
import { ExternalLink, FileCheck2 } from "lucide-react";
import { COMPLIANCE_DOCUMENTS } from "@/lib/compliance-documents";
import { buttonStyles } from "./primary-button";
import { Modal } from "./modal";

/**
 * The "KRA" button and the documents behind it.
 *
 * A client component for one reason: it opens a dialog. The documents are static
 * files, so nothing here fetches anything.
 *
 * The dialog is where the label gets explained. Three initials over two A4 scans
 * explain nothing on their own, so the panel names each document, says who issued
 * it, and links to the full-size file.
 *
 * `buttonClassName` exists so the button can sit on the dashboard footer and in
 * the profile list without duplicating the component.
 */
export function ComplianceDocuments({
  buttonClassName,
  label = "KRA",
  showIcon = true,
}: {
  buttonClassName?: string;
  label?: string;
  showIcon?: boolean;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClassName ?? buttonStyles({ variant: "outline", size: "sm" })}
      >
        {showIcon ? <FileCheck2 className="h-3.5 w-3.5" aria-hidden /> : null}
        {label}
        {/* Keeps the visible label intact while giving it a name that means something. */}
        <span className="sr-only"> — company registration documents</span>
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Company registration documents"
        description="TASK CASH PRO LIMITED, as filed with the Registrar of Companies."
        className="sm:max-w-2xl"
      >
        <div className="max-h-[65vh] space-y-5 overflow-y-auto pr-1">
          {COMPLIANCE_DOCUMENTS.map((document) => (
            <figure key={document.file} className="space-y-2">
              {/*
                A plain <img>: these are scans of a fixed pixel size already around
                60–85 KB, so an image optimiser would only add a layer. The white
                surround keeps a scan off the dark dialog surface edge to edge.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={document.file}
                alt={document.alt}
                loading="lazy"
                decoding="async"
                className="w-full rounded-tile border border-hairline bg-white"
              />
              <figcaption className="space-y-1">
                <p className="text-[13px] font-semibold text-white">{document.title}</p>
                <p className="text-[11px] leading-relaxed text-muted">{document.note}</p>
                <a
                  href={document.file}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-400 underline-offset-4 hover:underline"
                >
                  Open full size
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              </figcaption>
            </figure>
          ))}
        </div>
      </Modal>
    </>
  );
}
