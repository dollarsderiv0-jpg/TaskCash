import { requireAdmin } from "@/lib/auth/guards";
import { listAllAdvertisements } from "@/server/services/advertisements";
import { AdsEditor } from "@/components/admin/ads-editor";

export const dynamic = "force-dynamic";

export default async function AdminAdsPage() {
  await requireAdmin();
  const { ads, available } = await listAllAdvertisements();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Advertisements</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pictures shown in the sponsored gallery — company registration, deposit and withdrawal
          services. Display only: these pay no rewards.
        </p>
      </div>

      <AdsEditor advertisements={ads} available={available} />
    </div>
  );
}
