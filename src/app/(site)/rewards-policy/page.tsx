import type { Metadata } from "next";
import { LegalDoc } from "@/components/marketing/legal-doc";
import { getLegalDocument } from "@/content/legal";
import { notFound } from "next/navigation";

export const metadata: Metadata = { title: "Rewards Policy" };

export default function RewardsPolicyPage() {
  const doc = getLegalDocument("rewards-policy");
  if (!doc) notFound();
  return <LegalDoc doc={doc} />;
}
