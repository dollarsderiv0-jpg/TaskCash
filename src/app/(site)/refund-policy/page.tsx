import type { Metadata } from "next";
import { LegalDoc } from "@/components/marketing/legal-doc";
import { getLegalDocument } from "@/content/legal";
import { notFound } from "next/navigation";

export const metadata: Metadata = { title: "Refund Policy" };

export default function RefundPolicyPage() {
  const doc = getLegalDocument("refund-policy");
  if (!doc) notFound();
  return <LegalDoc doc={doc} />;
}
