import type { Metadata } from "next";
import { LegalDoc } from "@/components/marketing/legal-doc";
import { getLegalDocument } from "@/content/legal";
import { notFound } from "next/navigation";

export const metadata: Metadata = { title: "Terms of Service" };

export default function TermsPage() {
  const doc = getLegalDocument("terms");
  if (!doc) notFound();
  return <LegalDoc doc={doc} />;
}
