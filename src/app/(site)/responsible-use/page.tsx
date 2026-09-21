import type { Metadata } from "next";
import { LegalDoc } from "@/components/marketing/legal-doc";
import { getLegalDocument } from "@/content/legal";
import { notFound } from "next/navigation";

export const metadata: Metadata = { title: "Responsible Use & Financial Notice" };

export default function ResponsibleUsePage() {
  const doc = getLegalDocument("responsible-use");
  if (!doc) notFound();
  return <LegalDoc doc={doc} />;
}
