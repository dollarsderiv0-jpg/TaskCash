import Link from "next/link";
import { ArrowUpRight, Megaphone } from "lucide-react";
import { Badge } from "@/components/ui/misc";
import { adCategoryLabel } from "@/lib/types";

/**
 * The sponsored gallery on the PUBLIC landing page.
 *
 * A server component on purpose: an advert is a picture and a caption, so there
 * is no state to hold, no filter to run and no reason to ship JavaScript to a
 * visitor who has not even signed up. (The signed-in gallery at /dashboard/ads
 * does have category filters, which is why that one is a client component.)
 *
 * No timer, no reward, no "claim" button — looking at an advertisement pays
 * nobody. A control here that appeared to pay would be a lie, and on a rewards
 * site that is the most expensive kind of lie to tell.
 *
 * Rendering is defensive about one thing in particular: an advert whose creative
 * fails to load must not leave a broken image frame or, worse, an empty card
 * that reads as a missing feature. `onError` cannot be used here because this is
 * server-rendered, so the card is built to degrade on its own — the caption and
 * the advertiser carry the card whether or not the picture arrives.
 */

export type SponsoredAd = {
  id: string;
  title: string;
  description: string | null;
  advertiser: string | null;
  imageUrl: string;
  linkUrl: string | null;
  altText: string | null;
  category: string;
};

/**
 * `/register` is ours; `https://…` is somebody else's.
 *
 * The leading-slash test excludes `//` on purpose: `//host/path` is
 * PROTOCOL RELATIVE, so treating it as local would route an external fetch
 * through `next/link` and, worse, invite a same-page navigation to a third
 * party. Migration 0013 refuses to store such a value, and this refuses to
 * believe one if it ever gets in.
 */
function isSiteLocal(url: string) {
  return url.startsWith("/") && !url.startsWith("//");
}

function AdCard({ ad }: { ad: SponsoredAd }) {
  // An advert is never decoration, so the image is never announced as nothing:
  // it falls back to the title when no alt text was supplied.
  const alt = ad.altText?.trim() || ad.title;
  const local = ad.linkUrl ? isSiteLocal(ad.linkUrl) : false;

  /*
    A plain <img>, like the in-app gallery. The creative is operator-supplied and
    may be a self-hosted path or an advertiser's URL; next/image would require
    allow-listing every possible host in advance and would proxy third-party
    images through this app. The aspect wrapper reserves the space, so nothing
    shifts when the image arrives.
  */
  const media = (
    <div className="relative aspect-[16/9] w-full overflow-hidden rounded-t-2xl bg-secondary">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={ad.imageUrl}
        alt={alt}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
      />
    </div>
  );

  const body = (
    <div className="flex flex-1 flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="font-semibold leading-snug">{ad.title}</p>
        {ad.linkUrl ? (
          <ArrowUpRight
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
            aria-hidden
          />
        ) : null}
      </div>

      {ad.advertiser ? (
        <p className="text-xs font-medium text-muted-foreground">{ad.advertiser}</p>
      ) : null}

      {ad.description ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{ad.description}</p>
      ) : null}

      <div className="mt-auto pt-2">
        <Badge variant="outline">{adCategoryLabel(ad.category)}</Badge>
      </div>
    </div>
  );

  const shell =
    "group flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

  if (!ad.linkUrl) {
    // Purely informative picture. Not a link, and not made to look like one.
    return (
      <li className={shell}>
        {media}
        {body}
      </li>
    );
  }

  return (
    <li className="h-full">
      {local ? (
        <Link href={ad.linkUrl} className={shell}>
          {media}
          {body}
        </Link>
      ) : (
        <a
          href={ad.linkUrl}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className={shell}
        >
          {media}
          {body}
        </a>
      )}
    </li>
  );
}

export function SponsoredGallery({
  ads,
  title = "TaskCash Pro and our partners",
  subtitle = "Pictures placed by TaskCash Pro and advertisers using the platform.",
}: {
  ads: SponsoredAd[];
  title?: string;
  subtitle?: string;
}) {
  if (ads.length === 0) return null;

  return (
    <section aria-labelledby="sponsored-gallery-heading" className="border-b border-border">
      <div className="container py-14">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orangeBrand-500/12">
            <Megaphone className="h-4 w-4 text-orangeBrand-500" aria-hidden />
          </span>
          <div>
            <h2 id="sponsored-gallery-heading" className="text-2xl font-bold tracking-tight">
              {title}
            </h2>
            <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>

        <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {ads.map((ad) => (
            <AdCard key={ad.id} ad={ad} />
          ))}
        </ul>

        {/*
          Stated plainly, because the alternative is a visitor assuming a picture
          pays. On a rewards site that assumption is the expensive one.
        */}
        <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
          These are advertisements. Looking at them is free and does not earn a reward — paid
          activities are the sponsored videos in{" "}
          <Link className="underline underline-offset-2" href="/earn">
            Watch &amp; Earn
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
