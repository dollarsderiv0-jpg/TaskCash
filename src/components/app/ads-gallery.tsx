"use client";

import * as React from "react";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { adCategoryLabel } from "@/lib/types";

export type GalleryAd = {
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
 * The sponsored gallery.
 *
 * Everything here is presentation. There is no timer, no reward and no "claim"
 * button, because viewing an advertisement does not pay — the reward path is
 * Watch & Earn, and a control here that appeared to pay would be a lie.
 */
export function AdsGallery({ ads }: { ads: GalleryAd[] }) {
  const [category, setCategory] = React.useState<string>("ALL");

  const categories = React.useMemo(() => {
    const seen: string[] = [];
    for (const ad of ads) if (!seen.includes(ad.category)) seen.push(ad.category);
    return seen;
  }, [ads]);

  const shown = category === "ALL" ? ads : ads.filter((ad) => ad.category === category);

  return (
    <div className="space-y-5">
      {/* Filters. A single category needs no filter bar. */}
      {categories.length > 1 ? (
        <div className="tc-scroll-x -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          <Chip active={category === "ALL"} onClick={() => setCategory("ALL")}>
            All ({ads.length})
          </Chip>
          {categories.map((value) => (
            <Chip key={value} active={category === value} onClick={() => setCategory(value)}>
              {adCategoryLabel(value)}
            </Chip>
          ))}
        </div>
      ) : null}

      <ul className="grid gap-4 sm:grid-cols-2">
        {shown.map((ad) => (
          <li key={ad.id}>
            <AdCard ad={ad} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function AdCard({ ad }: { ad: GalleryAd }) {
  /*
    The image is announced as its alt text, falling back to the title. `alt=""`
    is only correct for decoration, and an advert is never decoration.
  */
  const alt = ad.altText?.trim() || ad.title;

  /*
    A plain <img> on purpose: the creative is hosted by the advertiser, on a
    host that is not known in advance. next/image would require allow-listing
    every domain up front and would proxy third-party images through this app,
    neither of which is wanted for an advertisement.
  */
  const media = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={ad.imageUrl}
      alt={alt}
      loading="lazy"
      decoding="async"
      // Fixed aspect ratio reserves the space before the image arrives, so the
      // list does not jump while it loads.
      className="aspect-[16/10] w-full bg-secondary object-cover transition-transform duration-300 group-hover:scale-[1.02]"
    />
  );

  const body = (
    <>
      <div className="relative overflow-hidden rounded-t-2xl">
        {media}
        <span className="absolute left-2 top-2 rounded-full bg-background/85 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
          Sponsored
        </span>
      </div>

      <div className="space-y-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold leading-snug">{ad.title}</h3>
          <Badge variant="outline" className="shrink-0">
            {adCategoryLabel(ad.category)}
          </Badge>
        </div>

        {ad.description ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{ad.description}</p>
        ) : null}

        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="truncate text-xs text-muted-foreground">
            {ad.advertiser ?? "Advertiser"}
          </span>
          {ad.linkUrl ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary">
              Learn more
              <ExternalLink className="h-3 w-3" aria-hidden />
            </span>
          ) : null}
        </div>
      </div>
    </>
  );

  const shell =
    "group block overflow-hidden rounded-2xl border border-border bg-card transition-colors";

  if (!ad.linkUrl) {
    return <div className={shell}>{body}</div>;
  }

  return (
    <a
      href={ad.linkUrl}
      target="_blank"
      // noopener stops the opened page reaching back through window.opener;
      // noreferrer keeps this app's address out of the advertiser's referrer
      // logs.
      rel="noopener noreferrer"
      className={cn(shell, "hover:border-primary/40")}
    >
      {body}
      <span className="sr-only"> (opens the advertiser&apos;s site in a new tab)</span>
    </a>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors",
        // `aria-pressed` carries the state for assistive tech; the colour is a
        // second signal, never the only one.
        active
          ? "border-primary/40 bg-primary/12 text-primary"
          : "border-border bg-card text-muted-foreground hover:bg-secondary/60",
      )}
    >
      {children}
    </button>
  );
}
