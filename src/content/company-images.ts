import type { PublicCompanyImage } from "@/server/services/company-images";

/**
 * The heading over the company pictures, on the landing page and on the
dashboard.
 *
 * One string, in one place, because it is a claim and claims are reviewed. It
 * reads "Sponsored by" at the operator's request: the pictures below it are meant
 * to be organisations sponsoring or working with the platform.
 *
 * Two things to hold in mind before changing who appears here:
 *
 *   · **Use a logo you are entitled to use.** A company's mark belongs to that
 *     company. Displaying it needs their permission, which typically comes as part
 *     of an actual sponsorship or partnership agreement — not from having found the
 *     file online.
 *   · **"Sponsored by" is a factual statement about a relationship.** Under a
 *     heading like this, a logo asserts that the company backs the platform. If
 *     that is not true of a particular company, the honest label for the section is
 *     something like "Companies we work with" or "Partners".
 *
 * Renaming it here is the whole change — both sections read this value.
 */
export const COMPANY_IMAGES_HEADING = "Sponsored by";

/**
 * Company pictures shipped with the app, used as the FALLBACK while the
 * `company_images` table does not exist.
 *
 * This is not the managed list any more — that is the table (migration 0016),
 * edited at /admin/company-images, and it takes precedence the moment it has rows.
 * These four are here for one reason: migration 0016 has not been applied to the
 * production database yet, and the section is supposed to be on the dashboard
 * today rather than after somebody pastes SQL.
 *
 * The precedence rule lives in `listShowcaseCompanyImages()` and is deliberately
 * simple: rows if there are rows, otherwise these. So the day the operator adds
 * their first picture in the admin, the database takes over completely and this
 * file stops being visible — including these four, which is what makes them
 * editable (rename, reorder, hide, delete) instead of pinned in code.
 *
 * Files live in `public/companies/` and are referenced as site-local paths, which
 * migration 0016 explicitly permits for exactly this case.
 */
export const BUNDLED_COMPANY_IMAGES: PublicCompanyImage[] = [
  {
    id: "bundled-workshop",
    name: "Technical workshop",
    caption: null,
    image_url: "/companies/workshop-partners.jpeg",
    link_url: null,
    sort_order: 10,
    status: "ACTIVE",
    created_at: "2026-09-21T00:00:00.000Z",
  },
  {
    id: "bundled-brand",
    name: "TaskCash Pro",
    caption: null,
    image_url: "/companies/taskcash-logo.jpeg",
    link_url: null,
    sort_order: 20,
    status: "ACTIVE",
    created_at: "2026-09-21T00:00:00.000Z",
  },
  {
    id: "bundled-sfic-team",
    name: "Stress Free Investment Club",
    caption: null,
    image_url: "/companies/sfic-team.jpeg",
    link_url: null,
    sort_order: 30,
    status: "ACTIVE",
    created_at: "2026-09-21T00:00:00.000Z",
  },
  {
    id: "bundled-sfic-celebration",
    name: "Five years with our members",
    caption: null,
    image_url: "/companies/sfic-celebration.jpeg",
    link_url: null,
    sort_order: 40,
    status: "ACTIVE",
    created_at: "2026-09-21T00:00:00.000Z",
  },
];
