-- ============================================================================
-- TaskCash Pro — 0016 Company images
--
-- The company pictures shown on the public landing page and on the signed-in
-- dashboard, managed by an administrator instead of by editing a file in the
-- repository.
--
-- WHY A TABLE RATHER THAN A LIST IN THE REPO
--
-- The first version of this section was a hand-maintained array in
-- `src/content/company-images.ts` pointing at files in `public/companies/`.
-- That works, and it is honest — but it makes every picture a code change: the
-- operator has to send someone a file, that file has to be committed, and the
-- site has to be redeployed before the picture appears. An advertisement already
-- works the other way (admin CRUD, 0009/0013); the pictures the operator owns
-- should behave the same way.
--
-- WHY THE BYTES ARE NOT IN THIS DATABASE
--
-- The object itself lives in Supabase Storage, in the `company-images` bucket
-- created at the bottom of this file. It is deliberately NOT a `bytea` column:
-- PostgREST would carry every image through the API as base64, and every
-- database backup would grow by the size of the picture library. `image_url` is
-- the address a browser loads directly, so nothing here proxies image bytes.
--
-- A pasted absolute URL and a site-local `/path` remain valid too, exactly as
-- with advertisements, so an externally hosted logo needs no upload at all.
--
-- SAME DESIGN RULE AS EVERY OTHER TABLE
--
-- The browser gets SELECT on visible rows and NO insert/update/delete policy at
-- all. Rows are created and changed through /api/admin/company-images with the
-- service role, so a client cannot publish a picture, reorder the section or
-- resurrect a hidden row.
--
-- DISPLAY ONLY: no reward, no ledger, no wallet is touched by anything here.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- table
-- ---------------------------------------------------------------------------
create table if not exists public.company_images (
  id           uuid primary key default gen_random_uuid(),
  -- The company's name. Required, and not decoration: it is the image's alt
  -- text, so a picture that fails to load still identifies the company instead
  -- of being announced as nothing at all.
  name         text not null,
  caption      text,
  -- The address a browser loads. A Storage public URL after an upload, an
  -- external https URL, or a site-local /path for a picture shipped with the app.
  image_url    text not null,
  -- Where the object lives inside the bucket, when this row was created by an
  -- upload. Null for a pasted URL. Kept so that deleting the row can also delete
  -- the stored object instead of leaving it to accumulate forever.
  storage_path text,
  -- Optional link. A site-local /path opens in place; anything else opens in a
  -- new tab.
  link_url     text,
  -- Lower sorts first; the tie-break is newest-first so a fresh upload is visible
  -- without anyone having to renumber the list.
  sort_order   int  not null default 100,
  -- HIDDEN is the pause: the row and its history survive, the public site stops
  -- showing it, decided by RLS rather than by a query in the app remembering to
  -- filter.
  status       text not null default 'ACTIVE',
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint company_images_name_len
    check (char_length(btrim(name)) between 2 and 120),
  -- 2048 is the practical ceiling browsers and proxies accept for a URL.
  --
  -- A root-relative path is accepted, and the pattern is `^/[^/]` rather than a
  -- bare leading slash: `//evil.example/x.png` is PROTOCOL RELATIVE, so
  -- accepting `/` alone would silently turn a local path into a third-party
  -- fetch. The same rule migration 0013 applies to advertisement creatives.
  constraint company_images_image_url_shape
    check (
      char_length(image_url) <= 2048
      and (image_url ~* '^https?://' or image_url ~ '^/[^/]')
    ),
  constraint company_images_link_url_shape
    check (
      link_url is null
      or (
        char_length(link_url) <= 2048
        and (link_url ~* '^https?://' or link_url ~ '^/[^/]')
      )
    ),
  constraint company_images_caption_len
    check (caption is null or char_length(btrim(caption)) between 1 and 300),
  constraint company_images_sort_order_check
    check (sort_order >= 0),
  constraint company_images_status_check
    check (status in ('ACTIVE', 'HIDDEN'))
);

-- ---------------------------------------------------------------------------
-- indexes — the section reads exactly one shape: visible rows in display order
-- ---------------------------------------------------------------------------
create index if not exists company_images_live_idx
  on public.company_images (status, sort_order, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance (reuses the 0001 helper)
-- ---------------------------------------------------------------------------
drop trigger if exists company_images_touch_trigger on public.company_images;
create trigger company_images_touch_trigger
  before update on public.company_images
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- row level security — read what is visible, write nothing
-- ---------------------------------------------------------------------------
alter table public.company_images enable row level security;

-- Signed-in readers: the dashboard shows this section, and every signed-in user
-- may see the pictures that are on the public landing page.
drop policy if exists company_images_select_visible on public.company_images;
create policy company_images_select_visible on public.company_images
  for select to authenticated
  using (status = 'ACTIVE');

-- Anonymous readers: the landing page is read by people who have not signed up,
-- and they are exactly the audience for this section. Same rule, different role.
drop policy if exists company_images_select_visible_public on public.company_images;
create policy company_images_select_visible_public on public.company_images
  for select to anon
  using (status = 'ACTIVE');

-- ---------------------------------------------------------------------------
-- privileges
--
-- RLS already denies every write (no policy exists to permit one), but revoking
-- the privilege too means a future mistake in policy land cannot quietly turn
-- this into a table the browser can write. Mirrors the 0004/0009 rule.
-- ---------------------------------------------------------------------------

-- Column-level for anonymous callers, deliberately without `created_by`: that is
-- the profile id of the administrator who uploaded the picture, and the public
-- page has no business reading it. Naming the columns means it stays true even
-- if the page is later changed to `select *` — PostgREST refuses the ungranted
-- column instead of quietly shipping an admin identifier to anonymous readers.
grant select (
  id,
  name,
  caption,
  image_url,
  link_url,
  sort_order,
  status,
  created_at,
  updated_at
) on public.company_images to anon;

grant select on public.company_images to authenticated;

revoke insert, update, delete, truncate on public.company_images from anon, authenticated;

-- ---------------------------------------------------------------------------
-- storage bucket for the uploaded files
--
-- GUARDED ON PURPOSE. The bucket is a Supabase Storage object and the local
-- Postgres harness used by `test:money:local` and `test:ads-schema` has no
-- `storage` schema at all — it applies every migration in this directory. An
-- unguarded insert would break those suites, which are green, in exchange for
-- nothing: on a real Supabase project the schema is always present, so the
-- branch always runs where it matters.
--
-- `public = true` means an object is served from its public URL without a
-- storage policy, which is right for a logo on a public landing page. Uploads
-- are performed server-side with the service role, which bypasses storage RLS,
-- so no write policy is declared here — and therefore no anonymous client can
-- write into this bucket by any route.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public)
    values ('company-images', 'company-images', true)
    on conflict (id) do update set public = true;
  end if;
end $$;
