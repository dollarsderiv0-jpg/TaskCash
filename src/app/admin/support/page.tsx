import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth/guards";
import { SupportQueue } from "@/components/admin/support-queue";

export const metadata: Metadata = { title: "Support requests" };

export const dynamic = "force-dynamic";

export default async function AdminSupportPage() {
  await requireAdmin();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Support requests</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What users have asked us, and what we told them. Every reply is recorded in the audit log.
        </p>
      </div>

      <SupportQueue />
    </div>
  );
}
