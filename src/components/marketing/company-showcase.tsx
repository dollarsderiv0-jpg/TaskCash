import Link from "next/link";
import { Building2 } from "lucide-react";
import {
  listShowcaseCompanyImages,
  type PublicCompanyImage,
} from "@/server/services/company-images";

/**
 * The company pictures on the PUBLIC landing page and on the signed-in dashboard.
 *
 * Managed by an administrator at /admin/company-images (migration 0016), not by a
 * file in this repository: the operator supplies the pictures, and publishing one
 * should not require a code change and a deploy.
 *
 * An async server component, like the sponsored gallery beside it, because the
 * rows come from the database. Both callers — the landing page and the dashboard —
 * are already `force-dynamic`, so nothing here is cached past the request that
 * asked for it and hiding a picture takes effect immediately.
 *
 * It renders NOTHING when there is nothing to show: no heading, no empty frame, no
 * placeholder tile. That covers both "no pictures yet" and "migration 0016 is not
 * applied on this deployment", and it matters because this is the first page a
 * stranger sees — an empty grey box there reads as a broken feature, which is
 * worse than the section simply not being there yet.
 */
export async function CompanyShowcase({
  title = "Companies behind TaskCash Pro",
  subtitle,
}: {
  title?: string;
  subtitle?: string;
}) {
  const images = await listShowcaseCompanyImages();
  if (images.length === 0) return null;

  return (
    <section aria-labelledby="company-showcase-heading" className="border-b border-border">
      <div className="container py-14">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orangeBrand-500/12">
            <Building2 className="h-4 w-4 text-orangeBrand-500" aria-hidden />
          </span>
          <div>
            <h2 id="company-showcase-heading" className="text-2xl font-bold tracking-tight">
              {title}
            </h2>
            {subtitle ? (
              <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{subtitle}</p>
            ) : null}
          </div>
        </div>

        <ul className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {images.map((image) => (
            <CompanyCard key={image.id} image={image} />
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * `/register` is ours; `https://…` is somebody else's.
 *
 * The leading-slash test excludes `//` on purpose: `//host/path` is PROTOCOL
 * RELATIVE, so treating it as local would invite a same-page navigation to a third
 * party. The same rule as the sponsored gallery, for the same reason — and the
 * same rule migration 0016 enforces before a row can be stored at all.
 */
function isSiteLocal(url: string) {
  return url.startsWith("/") && !url.startsWith("//");
}

function CompanyCard({ image }: { image: PublicCompanyImage }) {
  const href = image.link_url?.trim();
  const local = href ? isSiteLocal(href) : false;

  /*
    A plain <img>, exactly like the advertising creative, and for the same reason:
    these pictures are operator-supplied and may be an uploaded file, a site-local
    path, or an address on somebody else's host. next/image would require
    allow-listing every possible host in advance and would proxy third-party images
    through this app. The aspect wrapper reserves the space, so nothing shifts when
    a picture arrives.

    `object-contain` and not `object-cover`: these are logos, and cropping a logo to
    fit a frame mangles the one thing it exists to communicate.
  */
  const media = (
    <div className="relative aspect-[4/3] w-full overflow-hidden bg-secondary/50">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image.image_url}
        alt={image.name}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-contain p-5 transition-transform duration-300 group-hover:scale-[1.03]"
      />
    </div>
  );

  const body = (
    <div className="flex flex-1 flex-col gap-1 p-4">
      <p className="text-sm font-semibold leading-snug">{image.name}</p>
      {image.caption ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{image.caption}</p>
      ) : null}
    </div>
  );

  const shell =
    "group flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

  // A picture with no link is not a link, and is not made to look like one.
  if (!href) {
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
        <Link href={href} className={shell}>
          {media}
          {body}
        </Link>
      ) : (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={shell}>
          {media}
          {body}
        </a>
      )}
    </li>
  );
}
