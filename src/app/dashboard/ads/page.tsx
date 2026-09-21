import type { Metadata } from "next";
import Link from "next/link";
import { Megaphone, PlayCircle } from "lucide-react";
import { guardPage } from "@/lib/auth/guards";
import { listLiveAdvertisements } from "@/server/services/advertisements";
import { AdsGallery } from "@/components/app/ads-gallery";
import { Alert, EmptyState } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Advertisements" };

export const dynamic = "force-dynamic";

export default async function AdsPage() {
  // Looking at adverts costs nothing and creates nothing, so — like the wallet
  // and the dashboard — this page is open to an unverified account. Only the
  // pages that move money sit behind the verification gate.
  await guardPage();
  const { ads, available } = await listLiveAdvertisements();

  const items = ads.map((ad) => ({
    id: ad.id,
    title: ad.title,
    description: ad.description,
    advertiser: ad.advertiser,
    imageUrl: ad.image_url,
    linkUrl: ad.link_url,
    altText: ad.alt_text,
    category: ad.category,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Advertisements</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sponsored pictures from companies offering registration, deposit and withdrawal services.
        </p>
      </div>

      {/*
        Stated plainly, because the opposite would be a lie: these are adverts,
        not earnings. Someone who has just discovered they are paid for watching
        videos will reasonably assume a picture pays too, and would then chase a
        balance that was never going to move.
      */}
      <Alert variant="info" title="About this section">
        <p>
          These pictures are placed by advertisers. Looking at them is free and does not earn a
          reward — the paid activities are the sponsored videos in Watch &amp; Earn.
        </p>
      </Alert>

      {!available ? (
        <EmptyState
          icon={Megaphone}
          title="This section is being set up"
          description="The sponsored gallery is not available on this account yet. Please check back shortly."
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No advertisements right now"
          description="New sponsored pictures will appear here as soon as an advertiser publishes one."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/watch">
                <PlayCircle className="h-4 w-4" aria-hidden />
                Watch &amp; Earn instead
              </Link>
            </Button>
          }
        />
      ) : (
        <AdsGallery ads={items} />
      )}
    </div>
  );
}
