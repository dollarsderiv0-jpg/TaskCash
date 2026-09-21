-- ============================================================================
-- 0018 — App installs: recording that a user has the app on their device
-- ============================================================================
--
-- Why this exists at all: the withdrawal limits (floor, fee, the rolling
-- 24-hour ceiling) are NOT shown on the website. They are shown on the wallet
-- detail screen inside the installed app, and only to an account that has
-- actually installed it. So "has this user got the app?" has to be a durable,
-- server-side fact rather than a browser-local guess — otherwise clearing site
-- data, or a second device, would decide what a user is allowed to see about
-- their own money.
--
-- "Web APK" is Chrome's own term: installing the PWA (public/manifest.webmanifest
-- + public/sw.js) produces a WebAPK package on Android. There is no separate
-- .apk to ship, so the signals recorded here are the two the platform gives us:
--
--   STANDALONE    the page was launched inside the installed app
--                 (display-mode: standalone), which is only true post-install
--   APPINSTALLED  the browser's `appinstalled` event fired for this origin
--   MANUAL        the user pressed "I have added it to my home screen"
--
-- All three are recorded; the source is kept so the trail says which one it was,
-- and the column is stamped only once.
-- ============================================================================


-- ============================================================================
-- 1. the fact, on the profile
-- ============================================================================

alter table public.profiles
  add column if not exists app_downloaded_at timestamptz;

comment on column public.profiles.app_downloaded_at is
  'When the user first got the app onto a device. NULL means "not recorded". Set by record_app_install(); read to decide whether the wallet screen shows withdrawal limits.';


-- ============================================================================
-- 2. the trail
-- ============================================================================

create table if not exists public.app_installs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  source     text not null default 'MANUAL',
  user_agent text,
  created_at timestamptz not null default now(),
  constraint app_installs_source_check
    check (source in ('STANDALONE', 'APPINSTALLED', 'MANUAL'))
);

create index if not exists app_installs_user_idx
  on public.app_installs (user_id, created_at desc);

alter table public.app_installs enable row level security;

/*
  No policies, deliberately.

  Nothing reads this table to make a decision — the decision reads
  `profiles.app_downloaded_at`. This is evidence, written by the server with the
  service role, so leaving it unreachable from a browser means a client cannot
  manufacture "I installed the app" rows and cannot browse anyone's device
  history. Same shape as whatsapp_groups in 0015.
*/
revoke all on public.app_installs from anon, authenticated;


-- ============================================================================
-- 3. recording it, once
-- ============================================================================

create or replace function public.record_app_install(
  p_user_id    uuid,
  p_source     text default 'MANUAL',
  p_user_agent text default null
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source text;
  v_first  timestamptz;
begin
  if p_user_id is null then
    raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- An unknown source is stored as MANUAL rather than rejected: this is a
  -- convenience record, not a gate, and refusing it would lose the fact that the
  -- user really did install the app over a spelling mismatch.
  v_source := case
                when p_source in ('STANDALONE', 'APPINSTALLED', 'MANUAL') then p_source
                else 'MANUAL'
              end;

  -- Every report is kept, so a second device or a reinstall is visible in the
  -- trail rather than silently discarded.
  insert into public.app_installs (user_id, source, user_agent)
  values (p_user_id, v_source, left(coalesce(p_user_agent, ''), 400));

  /*
    The column, however, is only ever stamped once: it answers "when did this
    account first get the app", and letting a reinstall move that date would make
    it useless for exactly the thing it is for.
  */
  update public.profiles
     set app_downloaded_at = coalesce(app_downloaded_at, now())
   where id = p_user_id
  returning app_downloaded_at into v_first;

  return v_first;
end;
$$;

revoke all on function public.record_app_install(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_app_install(uuid, text, text) to service_role;

comment on function public.record_app_install(uuid, text, text) is
  'Records that a user has the app on a device: appends to app_installs and stamps profiles.app_downloaded_at on the first report only.';
