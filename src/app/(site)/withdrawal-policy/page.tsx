import type { Metadata } from "next";
import { LegalDoc } from "@/components/marketing/legal-doc";
import { getLegalDocument } from "@/content/legal";
import { notFound } from "next/navigation";

export const metadata: Metadata = { title: "Withdrawal Policy" };

export default function WithdrawalPolicyPage() {
  const doc = getLegalDocument("withdrawal-policy");
  if (!doc) notFound();
  return <LegalDoc doc={doc} />;
}
