import type { Metadata } from "next";
import { LegalDoc } from "@/components/marketing/legal-doc";
import { getLegalDocument } from "@/content/legal";
import { notFound } from "next/navigation";

export const metadata: Metadata = { title: "Cookie Policy" };

export default function CookiesPage() {
  const doc = getLegalDocument("cookies");
  if (!doc) notFound();
  return <LegalDoc doc={doc} />;
}
