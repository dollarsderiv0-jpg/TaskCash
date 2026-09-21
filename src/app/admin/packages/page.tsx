import { requireAdmin } from "@/lib/auth/guards";
import { listAllPackages, listPackageVideoIds, listVideoOptions } from "@/server/services/packages";
import { PackagesEditor } from "@/components/admin/packages-editor";

export const dynamic = "force-dynamic";

export default async function AdminPackagesPage() {
  await requireAdmin();

  const [{ packages: tiers, available }, videoIds, videos] = await Promise.all([
    listAllPackages(),
    listPackageVideoIds(),
    listVideoOptions(),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Packages</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Paid tiers a user activates from their wallet balance. Each package carries its own videos
          and a daily earning limit that resets at midnight (East Africa Time).
        </p>
      </div>

      <PackagesEditor packages={tiers} videoIds={videoIds} videos={videos} available={available} />
    </div>
  );
}
