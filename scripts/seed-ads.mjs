#!/usr/bin/env node
/**
 * Turn pictures in `public/ads/` into live advertisements.
 *
 *   node scripts/seed-ads.mjs                 # publish everything in public/ads
 *   node scripts/seed-ads.mjs --dry-run       # say what it would do, write nothing
 *   node scripts/seed-ads.mjs --draft         # create them hidden, for review first
 *   node scripts/seed-ads.mjs --remove        # remove the adverts it created
 *
 * WHY THIS EXISTS
 *
 * The operator supplies the creative — pictures of company-registration forms,
 * of people depositing, of people withdrawing. Until now each one had to be
 * uploaded to a third-party host and its absolute URL typed into /admin/ads,
 * because migration 0009 required `^https?://`.
 *
 * Migration 0013 allows a site-local path instead, so a picture dropped into
 * `public/ads/` is served from this application's own origin. No external host,
 * no CDN account, nothing that can rot or start charging.
 *
 * HOW IT MATCHES
 *
 * Idempotent on `image_url`. Re-running updates the adverts whose picture is
 * still on disk and leaves everything else alone — including adverts created by
 * hand in /admin/ads, which this never touches because their `image_url` does
 * not point at /ads/.
 *
 * IT DOES NOT INVENT CONTENT
 *
 * An advert needs a title, and a filename is not one. So:
 *
 *   · If `public/ads/manifest.json` describes a file, its words are used.
 *   · Otherwise the title is derived from the filename, the description is left
 *     NULL, and the run prints a warning naming the file. A derived title is a
 *     placeholder to be edited in /admin/ads — this says so rather than dressing
 *     it up as copy.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

/* -------------------------------------------------------------------------- */
/* env                                                                        */
/* -------------------------------------------------------------------------- */

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "").trim();

const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const SECRET = get("SUPABASE_SECRET_KEY");

if (!SUPABASE_URL || !SECRET) {
  console.error("\n  ✗ NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required in .env.local\n");
  process.exit(2);
}

/* -------------------------------------------------------------------------- */
/* args                                                                       */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const DRY_RUN = has("--dry-run");
const REMOVE = has("--remove");
const STATUS = has("--draft") ? "DRAFT" : "ACTIVE";

const CATEGORIES = ["COMPANY_REGISTRATION", "DEPOSITS", "WITHDRAWALS", "PAYMENTS", "OTHER"];
const DEFAULT_CATEGORY = value("category") ?? "OTHER";
const DEFAULT_LINK = value("link");

if (!CATEGORIES.includes(DEFAULT_CATEGORY)) {
  console.error(`\n  ✗ --category must be one of: ${CATEGORIES.join(", ")}\n`);
  process.exit(2);
}

/* -------------------------------------------------------------------------- */
/* the pictures on disk                                                       */
/* -------------------------------------------------------------------------- */

const ADS_DIR = new URL("../public/ads/", import.meta.url);
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif"];
// The database constrains image_url to a root-relative path; anything needing
// escaping in a URL (spaces, quotes, #, ?) would either break the fetch or be
// reinterpreted by a proxy, so such a filename is refused rather than mangled.
const URL_SAFE_NAME = /^[A-Za-z0-9._-]+$/;

if (!existsSync(ADS_DIR)) {
  console.error(`\n  ✗ public/ads/ does not exist. Create it and drop your pictures in.\n`);
  process.exit(2);
}

const manifestPath = new URL("../public/ads/manifest.json", import.meta.url);
let manifest = {};
if (existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.error(`\n  ✗ public/ads/manifest.json is not valid JSON: ${error.message}\n`);
    process.exit(2);
  }
}

const files = readdirSync(ADS_DIR)
  .filter((name) => IMAGE_EXTENSIONS.includes(name.slice(name.lastIndexOf(".")).toLowerCase()))
  .filter((name) => statSync(new URL(name, ADS_DIR)).isFile())
  .sort();

/** "company-registration-form.png" → "Company Registration Form" */
function titleFromFilename(name) {
  return name
    .slice(0, name.lastIndexOf("."))
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 160);
}

const rows = [];
const warnings = [];

for (const file of files) {
  if (!URL_SAFE_NAME.test(file)) {
    warnings.push(`skipped "${file}" — rename it to letters, numbers, dot, dash or underscore`);
    continue;
  }

  const meta = manifest[file] ?? {};
  const imageUrl = `/ads/${file}`;

  const title = typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : null;
  if (!title) {
    warnings.push(`"${file}" has no title in manifest.json — using a placeholder derived from the filename`);
  }

  const category = meta.category ?? DEFAULT_CATEGORY;
  if (!CATEGORIES.includes(category)) {
    warnings.push(`skipped "${file}" — manifest category "${category}" is not one of ${CATEGORIES.join(", ")}`);
    continue;
  }

  const row = {
    title: title ?? titleFromFilename(file),
    description: meta.description ?? null,
    advertiser: meta.advertiser ?? "TaskCash Pro",
    image_url: imageUrl,
    link_url: meta.linkUrl ?? DEFAULT_LINK ?? null,
    alt_text: meta.altText ?? title ?? null,
    category,
    sort_order: Number.isFinite(Number(meta.sortOrder)) ? Number(meta.sortOrder) : 100,
    status: meta.status ?? STATUS,
  };

  // Mirrors the database check so a bad value is caught here, with a filename,
  // rather than as a constraint violation with a row id.
  if (row.link_url && !/^https?:\/\//i.test(row.link_url) && !/^\/[^/]/.test(row.link_url)) {
    warnings.push(`skipped "${file}" — linkUrl must be https://… or a site path like /register`);
    continue;
  }

  rows.push(row);
}

/* -------------------------------------------------------------------------- */
/* write                                                                      */
/* -------------------------------------------------------------------------- */

const db = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * The state a fresh deployment is actually in: the pictures are on disk and the
 * table is not there yet, because 0009/0013 have not been applied. Report it as
 * what it is — a missing migration — rather than as a failed write, which would
 * send someone hunting for the wrong problem.
 */
function explain(error) {
  const missingTable =
    error?.code === "PGRST205" ||
    error?.code === "42P01" ||
    /could not find the table|relation .* does not exist/i.test(error?.message ?? "");

  if (missingTable) {
    return (
      `${error.message}\n\n` +
      "  The advertisements table does not exist yet, so the pictures cannot be\n" +
      "  registered. Apply the outstanding migrations first:\n\n" +
      "    node scripts/bundle-migrations.mjs   # regenerate supabase/apply-all.sql\n" +
      "    then paste supabase/apply-all.sql into the Supabase SQL Editor and Run\n"
    );
  }

  const missingColumn =
    error?.code === "PGRST204" || /column .* does not exist/i.test(error?.message ?? "");
  if (missingColumn && /link_url|image_url/.test(error.message)) {
    return (
      `${error.message}\n\n` +
      "  Migration 0013 relaxes image_url/link_url to allow a site-local path\n" +
      "  (/ads/…). It has not been applied to this database yet.\n"
    );
  }

  return error?.message ?? String(error);
}

console.log(`\n  pictures found : ${files.length}`);
rows.forEach((row) => console.log(`    · ${row.image_url}  →  "${row.title}"  [${row.category}/${row.status}]`));
warnings.forEach((w) => console.log(`    ! ${w}`));

if (REMOVE) {
  const { data, error } = await db
    .from("advertisements")
    .delete()
    .like("image_url", "/ads/%")
    .select("id, image_url");

  if (error) {
    console.error(`\n  ✗ delete failed:\n\n  ${explain(error)}\n`);
    process.exit(1);
  }

  console.log(`\n  removed ${data?.length ?? 0} advert(s) whose picture lives in public/ads.\n`);
  process.exit(0);
}

if (rows.length === 0) {
  console.log("\n  nothing to do — drop pictures into public/ads, then run this again.\n");
  process.exit(0);
}

if (DRY_RUN) {
  console.log("\n  dry run — nothing was written.\n");
  process.exit(0);
}

// Upsert by image_url, one at a time: PostgREST's upsert needs a unique
// constraint on the conflict target and image_url is deliberately not unique
// (the same picture may legitimately be advertised twice). Matching explicitly
// also keeps the update path from touching `created_by`, which an upsert would
// have to supply on insert only.
let created = 0;
let updated = 0;

for (const row of rows) {
  const { data: existing, error: findError } = await db
    .from("advertisements")
    .select("id")
    .eq("image_url", row.image_url)
    .maybeSingle();

  if (findError) {
    console.error(`\n  ✗ lookup failed for ${row.image_url}:\n\n  ${explain(findError)}\n`);
    process.exit(1);
  }

  const { error } = existing
    ? await db.from("advertisements").update(row).eq("id", existing.id)
    : await db.from("advertisements").insert(row);

  if (error) {
    console.error(`\n  ✗ write failed for ${row.image_url}:\n\n  ${explain(error)}\n`);
    process.exit(1);
  }

  if (existing) updated += 1;
  else created += 1;
}

const { count } = await db
  .from("advertisements")
  .select("id", { count: "exact", head: true })
  .like("image_url", "/ads/%");

console.log(`\n  created ${created}, updated ${updated}.`);
console.log(`  ${count ?? 0} advert(s) now point at public/ads.`);
if (STATUS === "ACTIVE") {
  console.log("  They are ACTIVE, so they appear on the home page and in /dashboard/ads immediately.");
} else {
  console.log("  They are DRAFT — publish them in /admin/ads when you have checked them.");
}
console.log('');
