-- ============================================================================
-- TaskCash Pro — 0013 Advertisements on the public site
--
-- 0009 gave the signed-in app a sponsored gallery. This migration adds the two
-- things the LANDING PAGE needs, and nothing else.
--
--   1. PUBLIC READ.
--
--      0009 granted SELECT to `authenticated` only, which is correct for a
--      gallery behind the login wall and useless for advertising: the home page
--      is read by people who have not signed up, and they are exactly the
--      audience an advert is for. Live rows therefore become readable by `anon`
--      too.
--
--      This is a COLUMN-LEVEL grant rather than a blanket table grant. The
--      public page needs the creative and its caption; it has no business
--      reading `created_by`, which is the profile id of the admin who uploaded
--      it. Naming the columns means that stays true even if the page is later
--      changed to `select *` — PostgREST refuses the ungranted column instead of
--      quietly shipping an admin identifier to anonymous readers.
--
--      RLS still decides WHICH rows those columns are visible on. The rule is
--      unchanged from 0009 and is not restated loosely here: ACTIVE, and inside
--      its schedule window. Pausing an advert or letting it expire hides it from
--      the public site at the database, not by a query in the app remembering
--      to filter.
--
--   2. SELF-HOSTED CREATIVES.
--
--      0009 required `^https?://`, so an image had to be hosted somewhere else
--      and referenced by absolute URL. The operator supplies the pictures, and
--      the natural home for them is this application's own `public/ads`
--      directory, served from the site's own origin — no third-party host, no
--      allow-listing in `next/image`, no external dependency that can rot.
--
--      A root-relative path is therefore accepted. The pattern is `^/[^/]` and
--      that second character matters: `//evil.example/x.png` is PROTOCOL
--      RELATIVE, so accepting a bare leading slash would silently turn a local
--      path into a third-party fetch. The same applies to the link target, which
--      lets an advert point at an internal page such as /register.
--
-- No reward is involved. Viewing an advertisement still pays nobody, so this
-- migration touches no ledger, no wallet and no session.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- creative + link may be absolute URLs OR site-local paths
-- ---------------------------------------------------------------------------

alter table public.advertisements
  drop constraint if exists advertisements_image_url_shape;

alter table public.advertisements
  add constraint advertisements_image_url_shape
  check (
    char_length(image_url) <= 2048
    and (image_url ~* '^https?://' or image_url ~ '^/[^/]')
  );

alter table public.advertisements
  drop constraint if exists advertisements_link_url_shape;

alter table public.advertisements
  add constraint advertisements_link_url_shape
  check (
    link_url is null
    or (
      char_length(link_url) <= 2048
      and (link_url ~* '^https?://' or link_url ~ '^/[^/]')
    )
  );

-- ---------------------------------------------------------------------------
-- anonymous read of live adverts
-- ---------------------------------------------------------------------------

-- Read-only, and only the columns the public gallery renders. `created_by` is
-- deliberately absent.
grant select (
  id,
  title,
  description,
  advertiser,
  image_url,
  link_url,
  alt_text,
  category,
  sort_order,
  status,
  starts_at,
  ends_at,
  created_at,
  updated_at
) on public.advertisements to anon;

-- Mirrors advertisements_select_live exactly; the only difference is the role.
drop policy if exists advertisements_select_live_public on public.advertisements;
create policy advertisements_select_live_public on public.advertisements
  for select to anon
  using (
    status = 'ACTIVE'
    and (starts_at is null or starts_at <= now())
    and (ends_at   is null or ends_at   >  now())
  );

-- Writes stay impossible for anonymous callers, exactly as in 0009. Stated again
-- rather than assumed: this migration widens a read and must not widen a write.
revoke insert, update, delete, truncate on public.advertisements from anon;
