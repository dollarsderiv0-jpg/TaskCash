-- ============================================================================
-- TaskCash Pro — 0009 Advertisements
--
-- A sponsored gallery: pictures supplied by advertisers — company-registration
-- services, deposit and withdrawal services, payment providers — shown inside
-- the app.
--
-- DISPLAY ONLY. Viewing an advertisement pays nobody, so there is no ledger
-- entry, no reward column, no budget to exhaust and no session to verify. That
-- is deliberate: the money path in this project is the video campaign system
-- (0001/0003), and duplicating it here would double the surface that has to be
-- got right for no gain. If ads ever pay, they belong in a campaign with a
-- budget and a server-side watch check, not in a gallery.
--
-- Same design rule as every other table: the browser gets SELECT on live rows
-- and no INSERT/UPDATE/DELETE policy at all. Advertisements are created and
-- changed through /api/admin/ads with the service role, so a client cannot
-- publish its own creative, extend its own schedule, or resurrect an archived
-- row.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- table
-- ---------------------------------------------------------------------------
create table if not exists public.advertisements (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  description  text,
  advertiser   text,
  -- The image itself. A full URL rather than a storage path, because the
  -- creative may be hosted by the advertiser; nothing here fetches or proxies
  -- it, so the URL must be one a browser can load directly.
  image_url    text not null,
  -- Where a tap goes. Optional: a picture can be purely informative.
  link_url     text,
  -- Screen-reader text. Optional in the database but never absent in the UI:
  -- the gallery falls back to the title, so an image is never announced as
  -- nothing at all.
  alt_text     text,
  category     text not null default 'OTHER',
  -- Lower sorts first; the tie-break is newest-first so a fresh upload is
  -- visible without anyone having to renumber a list.
  sort_order   int  not null default 100,
  status       text not null default 'DRAFT',
  starts_at    timestamptz,
  ends_at      timestamptz,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint advertisements_title_len
    check (char_length(btrim(title)) between 2 and 160),
  -- 2048 is the practical ceiling browsers and proxies accept for a URL.
  constraint advertisements_image_url_shape
    check (image_url ~* '^https?://' and char_length(image_url) <= 2048),
  constraint advertisements_link_url_shape
    check (link_url is null or (link_url ~* '^https?://' and char_length(link_url) <= 2048)),
  constraint advertisements_alt_text_len
    check (alt_text is null or char_length(btrim(alt_text)) between 3 and 300),
  constraint advertisements_sort_order_check
    check (sort_order >= 0),
  constraint advertisements_category_check
    check (category in ('COMPANY_REGISTRATION', 'DEPOSITS', 'WITHDRAWALS', 'PAYMENTS', 'OTHER')),
  constraint advertisements_status_check
    check (status in ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED')),
  constraint advertisements_window_check
    check (ends_at is null or starts_at is null or ends_at > starts_at)
);

-- ---------------------------------------------------------------------------
-- indexes — the gallery reads exactly one shape: live rows in display order
-- ---------------------------------------------------------------------------
create index if not exists advertisements_live_idx
  on public.advertisements (status, sort_order, created_at desc);
create index if not exists advertisements_category_idx
  on public.advertisements (category, sort_order);

-- ---------------------------------------------------------------------------
-- updated_at maintenance (reuses the 0001 helper)
-- ---------------------------------------------------------------------------
drop trigger if exists advertisements_touch_trigger on public.advertisements;
create trigger advertisements_touch_trigger
  before update on public.advertisements
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- row level security — read only what is live, write nothing
-- ---------------------------------------------------------------------------
alter table public.advertisements enable row level security;

-- A row is only readable while it is ACTIVE *and* inside its schedule window,
-- so "pause it" and "it ended last night" both take effect at the database
-- rather than depending on a query in the app remembering to filter.
drop policy if exists advertisements_select_live on public.advertisements;
create policy advertisements_select_live on public.advertisements
  for select to authenticated
  using (
    status = 'ACTIVE'
    and (starts_at is null or starts_at <= now())
    and (ends_at   is null or ends_at   >  now())
  );

-- ---------------------------------------------------------------------------
-- privileges
--
-- RLS already denies every write (no policy exists to permit one), but revoking
-- the privilege too means a future mistake in policy land cannot quietly turn
-- this into a table the browser can write. Mirrors the 0004 rule.
-- ---------------------------------------------------------------------------
revoke insert, update, delete, truncate on public.advertisements from anon, authenticated;
grant select on public.advertisements to authenticated;
