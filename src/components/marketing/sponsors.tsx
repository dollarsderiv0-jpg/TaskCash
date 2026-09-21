import { listPublicAdvertisements } from "@/server/services/advertisements";
import { SponsoredGallery } from "@/components/marketing/sponsored-gallery";

/**
 * The landing page's advertising slot.
 *
 * A thin async wrapper, and it exists for one reason: the landing page must not
 * care whether the advertisement table is there yet. `listPublicAdvertisements`
 * reports a pending migration as `available: false` rather than throwing, and
 * this swallows that case into "render nothing".
 *
 * That matters more here than anywhere else in the app. This is the first page a
 * stranger sees; a 500 or an empty grey box where advertising should be is a far
 * worse outcome than no advertising at all, and both are the status quo until
 * migrations 0009 and 0013 are applied.
 *
 * Deliberately NOT cached: adverts have a schedule window, and "expires at 18:00"
 * has to mean 18:00 rather than "18:00, or whenever this page was last built".
 * The caller (`(site)/layout.tsx`) is already `force-dynamic`.
 */
export async function Sponsors({ limit = 6 }: { limit?: number }) {
  const { ads, available } = await listPublicAdvertisements(limit);
  if (!available || ads.length === 0) return null;

  return (
    <SponsoredGallery
      ads={ads.map((ad) => ({
        id: ad.id,
        title: ad.title,
        description: ad.description,
        advertiser: ad.advertiser,
        imageUrl: ad.image_url,
        linkUrl: ad.link_url,
        altText: ad.alt_text,
        category: ad.category,
      }))}
    />
  );
}
