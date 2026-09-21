import type { Metadata } from "next";
import { LegalDoc } from "@/components/marketing/legal-doc";
import { getLegalDocument } from "@/content/legal";
import { notFound } from "next/navigation";

export const metadata: Metadata = { title: "Privacy Policy" };

export default function PrivacyPage() {
  const doc = getLegalDocument("privacy");
  if (!doc) notFound();
  return <LegalDoc doc={doc} />;
}
