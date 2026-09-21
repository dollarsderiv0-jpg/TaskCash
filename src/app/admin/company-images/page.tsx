import { requireAdmin } from "@/lib/auth/guards";
import { listAllCompanyImages } from "@/server/services/company-images";
import { CompanyImagesEditor } from "@/components/admin/company-images-editor";

export const dynamic = "force-dynamic";

export default async function AdminCompanyImagesPage() {
  await requireAdmin();
  const { images, available } = await listAllCompanyImages();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Company images</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The pictures of the companies behind the platform, shown on the home page and on the
          signed-in dashboard. Display only: these pay no rewards.
        </p>
      </div>

      <CompanyImagesEditor images={images} available={available} />
    </div>
  );
}
