/*
  0020 — one catalogue, a rate per package.

  Until now `videos.reward_amount` was global and `package_videos` had a UNIQUE
  index on `video_id`, so a video belonged to exactly ONE package and paid the
  same everywhere. "The same six videos pay 10 under Package 800 and 30 under the
  next tier" was therefore impossible to express.

  Two changes make it expressible:

    1. `package_videos.reward_amount` — what THIS package pays for that video.
       LEFT JOINed against the video's own figure, so a row with no rate behaves
       exactly as it does today and no existing data has to be rewritten.
    2. the UNIQUE index on `video_id` goes, so a video can appear in several
       packages. That is what makes the catalogue SHARED: the same video pays
       differently depending on which tier the viewer holds.

  WHAT THIS DOES NOT CHANGE
  -------------------------
  · `videos.reward_amount` stays the free video's rate and the fallback for any
    package row without its own. Nothing is nulled and nothing is migrated by
    force.
  · The daily and lifetime caps still come from the PURCHASE snapshot on
    `user_packages`, and `package_daily_usage` still sums the ledger by
    `session.package_id`. Per-package rates need no change there — the caps were
    always per package, and now the amounts feeding them are too.
  · `campaign_is_payable` is still the ceiling. It is now checked twice at start:
    once at the video's base rate (exactly where it always was, so a video in no
    package behaves identically) and again at the resolved package rate, which is
    the stricter of the two.

  THE ONE REAL HAZARD
  -------------------
  `videos.daily_limit` is counted per (user, video). With a shared catalogue that
  would let a viewer earn from a video ONCE and then be blocked from the same
  video under every other tier they hold — the higher rate would be unreachable
  for the very people who paid for it. So the per-video daily limit is now scoped
  to the package: one rewarded view per video PER PACKAGE per day. The platform
  daily cap, the hourly velocity guard and every watch-time rule are unchanged
  and still apply across all of them.
*/

/* -------------------------------------------------------------------------- */
/* 1. the per-package rate                                                    */
/* -------------------------------------------------------------------------- */

alter table public.package_videos
  add column if not exists reward_amount numeric(20,4)
    check (reward_amount is null or reward_amount >= 0);

comment on column public.package_videos.reward_amount is
  'What THIS package pays for a rewarded view of this video. NULL falls back to '
  'videos.reward_amount, so a row written before 0020 keeps its old behaviour.';

/*
  The one-package-per-video rule is replaced by one ROW per (package, video) —
  which the primary key already enforces. Kept as a plain index because the
  hot lookup is still "which packages gate this video".
*/
drop index if exists public.package_videos_one_package_idx;

create index if not exists package_videos_video_idx
  on public.package_videos (video_id);


/* -------------------------------------------------------------------------- */
/* 2. video_start — pick the package the viewer HOLDS, and pay its rate        */
/* -------------------------------------------------------------------------- */

create or replace function public.video_start(
  p_user_id     uuid,
  p_video_id    uuid,
  p_ip_hash     text default null,
  p_device_hash text default null
)
returns table (
  session_id             uuid,
  session_token          uuid,
  video_id               uuid,
  title                  text,
  description            text,
  video_url              text,
  thumbnail_url          text,
  duration_seconds       int,
  required_watch_seconds int,
  reward_amount          numeric,
  currency               text,
  started_at             timestamptz,
  watched_seconds        numeric,
  status                 text,
  resumed                boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
  v_video   public.videos;
  v_session public.video_watch_sessions;
  v_recent  int;
  v_velocity int;
  v_package_id uuid;
  v_rate    numeric(20,4);
  v_candidate record;
  v_usage   record;
  v_any_held boolean := false;
  v_any_expired boolean := false;
  v_exhausted_daily boolean := false;
  v_exhausted_total boolean := false;
  v_exhausted_video boolean := false;
begin
  select * into v_profile from public.profiles where id = p_user_id;
  if not found then
    raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_profile.status <> 'ACTIVE' then
    raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if v_profile.risk_status in ('RESTRICTED','SUSPENDED') then
    raise exception 'ACCOUNT_RESTRICTED' using errcode = 'P0001';
  end if;
  if public.setting_bool('security.require_email_verified_to_earn', false)
     and v_profile.email_verified_at is null then
    raise exception 'EMAIL_VERIFICATION_REQUIRED' using errcode = 'P0001';
  end if;

  select * into v_video from public.videos where id = p_video_id;
  if not found then
    raise exception 'VIDEO_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_video.status <> 'ACTIVE' then
    raise exception 'VIDEO_NOT_AVAILABLE' using errcode = 'P0001';
  end if;
  if v_video.total_view_limit is not null and v_video.total_views >= v_video.total_view_limit then
    raise exception 'VIDEO_VIEW_LIMIT_REACHED' using errcode = 'P0001';
  end if;
  /*
    Unchanged, and deliberately left in its original position: a video in no
    package must keep behaving exactly as it did, including which error it raises
    first. The package's OWN rate is checked again below, once it is known.
  */
  if not public.campaign_is_payable(v_video.campaign_id, v_video.reward_amount) then
    raise exception 'CAMPAIGN_NOT_PAYABLE' using errcode = 'P0001';
  end if;

  -- The rate this session will actually pay, before any package is considered.
  v_rate := v_video.reward_amount;

  -- --------------------------------------------------------------------------
  -- The package gate.
  --
  -- A video in no package skips this entirely and behaves exactly as before.
  --
  -- A video in SEVERAL packages (0020) picks between them, best rate first, and
  -- only among the tiers the viewer actually holds. Picking the highest rate is
  -- the predictable rule: they get the best tier they paid for. A held tier that
  -- is already exhausted is skipped rather than fatal, because holding a second
  -- tier that still has headroom should not be wasted by the first one running
  -- out.
  -- --------------------------------------------------------------------------
  if exists (select 1 from public.package_videos pv where pv.video_id = p_video_id) then
    for v_candidate in
      select pv.package_id,
             coalesce(pv.reward_amount, v_video.reward_amount) as rate
        from public.package_videos pv
       where pv.video_id = p_video_id
       order by coalesce(pv.reward_amount, v_video.reward_amount) desc, pv.package_id
    loop
      select * into v_usage
        from public.package_daily_usage(p_user_id, v_candidate.package_id);

      if not v_usage.has_active_purchase then
        if v_usage.purchase_expired then
          v_any_expired := true;
        end if;
        continue;
      end if;

      v_any_held := true;

      if v_usage.daily_cap <= 0 then
        continue;
      end if;
      if v_usage.earned_today >= v_usage.daily_cap then
        v_exhausted_daily := true;
        continue;
      end if;
      /*
        The lifetime ceiling, checked at START as well as at collect. Once it is
        reached the package never pays again, so letting the user sit through a
        video that cannot be rewarded would waste their time for nothing.
      */
      if v_usage.lifetime_cap is not null and v_usage.earned_total >= v_usage.lifetime_cap then
        v_exhausted_total := true;
        continue;
      end if;

      /*
        The per-video daily limit, checked INSIDE the loop and per candidate.

        It is scoped to the package (that is the whole point of 0020), so it has
        to be evaluated per candidate too: with it outside the loop, a viewer who
        had already earned from this video under their top tier would be refused
        outright instead of falling through to the tier they also hold — which is
        exactly the case a shared catalogue creates.
      */
      select count(*) into v_recent
        from public.video_watch_sessions s
       where s.user_id = p_user_id
         and s.video_id = p_video_id
         and s.status = 'REWARDED'
         and s.package_id = v_candidate.package_id
         and s.rewarded_at >= date_trunc('day', now());
      if v_video.daily_limit > 0 and v_recent >= v_video.daily_limit then
        v_exhausted_video := true;
        continue;
      end if;

      v_package_id := v_candidate.package_id;
      v_rate := v_candidate.rate;
      exit;
    end loop;

    if v_package_id is null then
      /*
        Nothing payable. The reason decides the code, because each one is a
        different thing to tell the viewer: a lapsed term gets its own code
        ("you need a package" is wrong for someone who bought one and ran out of
        days), and a spent allowance is a WAIT, not an error — the UI turns it
        into a countdown against `resets_at`.
      */
      if v_exhausted_total then
        raise exception 'PACKAGE_TOTAL_LIMIT_REACHED' using errcode = 'P0001';
      end if;
      if v_exhausted_daily then
        raise exception 'PACKAGE_DAILY_LIMIT_REACHED' using errcode = 'P0001';
      end if;
      if v_exhausted_video then
        raise exception 'VIDEO_DAILY_LIMIT_REACHED' using errcode = 'P0001';
      end if;
      if v_any_expired then
        raise exception 'PACKAGE_EXPIRED' using errcode = 'P0001';
      end if;
      raise exception 'PACKAGE_REQUIRED' using errcode = 'P0001';
    end if;

    -- Now that the rate is known, hold the campaign to it. Stricter than the
    -- base-rate check above, and the reason a shared catalogue stays honest: a
    -- tier paying 30 is refused when the campaign can only still afford 20.
    if not public.campaign_is_payable(v_video.campaign_id, v_rate) then
      raise exception 'CAMPAIGN_NOT_PAYABLE' using errcode = 'P0001';
    end if;
  end if;

  -- Velocity guard: a human cannot legitimately finish many videos per hour.
  select count(*) into v_velocity
    from public.video_watch_sessions s
   where s.user_id = p_user_id
     and s.status = 'REWARDED'
     and s.rewarded_at > now() - interval '1 hour';
  if v_velocity >= greatest(1, public.setting_num('fraud.max_rewarded_sessions_per_hour', 40)::int) then
    perform public.record_fraud_event(
      p_user_id, 'WATCH_VELOCITY_EXCEEDED', 'MEDIUM', 15,
      jsonb_build_object('rewarded_last_hour', v_velocity, 'video_id', p_video_id)
    );
    raise exception 'VELOCITY_BLOCKED' using errcode = 'P0001';
  end if;

  -- Cooldown between watches of the same video.
  if public.setting_num('rewards.cooldown_seconds', 0) > 0 and exists (
    select 1 from public.video_watch_sessions s
     where s.user_id = p_user_id
       and s.video_id = p_video_id
       and s.status = 'REWARDED'
       and s.rewarded_at > now() - make_interval(secs => public.setting_num('rewards.cooldown_seconds', 0)::int)
  ) then
    raise exception 'VIDEO_COOLDOWN_ACTIVE' using errcode = 'P0001';
  end if;

  /*
    The package-less path's daily limit.

    For a video in a package this is already settled inside the loop, and the
    selected candidate is known to be under its limit, so this re-check is a
    no-op. It is kept because a video in NO package must behave exactly as it did
    before 0020, including which error it raises.
  */
  select count(*) into v_recent
    from public.video_watch_sessions s
   where s.user_id = p_user_id
     and s.video_id = p_video_id
     and s.status = 'REWARDED'
     and s.package_id is not distinct from v_package_id
     and s.rewarded_at >= date_trunc('day', now());
  if v_video.daily_limit > 0 and v_recent >= v_video.daily_limit then
    raise exception 'VIDEO_DAILY_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  -- Resume an in-flight session instead of stacking duplicates.
  select * into v_session
    from public.video_watch_sessions s
   where s.user_id = p_user_id
     and s.video_id = p_video_id
     and s.status in ('STARTED','WATCHING')
     and s.started_at > now() - interval '40 minutes'
   order by s.started_at desc
   limit 1;

  if found then
    update public.video_watch_sessions
       set last_activity_at = now(),
           status = 'WATCHING',
           -- Re-stamp the package, so a session started before this migration
           -- (or before the video was added to a tier) is attributed correctly.
           package_id = coalesce(v_package_id, package_id)
     where id = v_session.id
     returning * into v_session;

    return query
      select v_session.id, v_session.session_token, v_video.id, v_video.title, v_video.description,
             v_video.video_url, v_video.thumbnail_url, v_video.duration_seconds,
             v_session.required_watch_seconds, v_rate, v_video.currency,
             v_session.started_at, v_session.watched_seconds, v_session.status, true;
    return;
  end if;

  insert into public.video_watch_sessions (
    user_id, video_id, required_watch_seconds, ip_hash, device_hash, status, package_id
  ) values (
    p_user_id, p_video_id, v_video.required_watch_seconds, p_ip_hash, p_device_hash, 'WATCHING', v_package_id
  )
  returning * into v_session;

  return query
    select v_session.id, v_session.session_token, v_video.id, v_video.title, v_video.description,
           v_video.video_url, v_video.thumbnail_url, v_video.duration_seconds,
           v_session.required_watch_seconds, v_rate, v_video.currency,
           v_session.started_at, v_session.watched_seconds, v_session.status, false;
end;
$$;

revoke all on function public.video_start(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.video_start(uuid, uuid, text, text) to service_role;


/* -------------------------------------------------------------------------- */
/* 3. video_complete_session — pay the rate of the package that was charged    */
/* -------------------------------------------------------------------------- */

create or replace function public.video_complete_session(
  p_user_id       uuid,
  p_session_token uuid
)
returns table (
  result_status   text,
  reward_amount   numeric,
  currency        text,
  transaction_id  uuid,
  reference       text,
  watched_seconds numeric,
  reject_reason   text,
  duplicate       boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session  public.video_watch_sessions;
  v_video    public.videos;
  v_profile  public.profiles;
  v_elapsed  numeric;
  v_reward   numeric(20,4);
  v_tx       public.wallet_transactions;
  v_daily    int;
  v_ref      text;
  v_usage    record;
begin
  perform pg_advisory_xact_lock(hashtext('session:' || p_session_token::text));

  select * into v_session
    from public.video_watch_sessions
   where session_token = p_session_token and user_id = p_user_id
   for update;

  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_video from public.videos where id = v_session.video_id;
  select * into v_profile from public.profiles where id = p_user_id;

  /*
    The reward is resolved ONCE, here, and every gate below reads this value.

    Computed before the early returns so the idempotent path reports the amount
    the session actually paid rather than re-deriving it from data that may have
    been re-priced since. `coalesce` is what keeps 0020 backward compatible: a
    package row with no rate of its own falls back to the video's figure.

    It is still never read from the client — the package row and the video row
    are the only two sources, and both are server-side.
  */
  v_reward := coalesce(
    (select pv.reward_amount
       from public.package_videos pv
      where pv.package_id = v_session.package_id
        and pv.video_id = v_video.id),
    v_video.reward_amount
  );

  -- Idempotent: a session rewards exactly once, ever.
  if v_session.status = 'REWARDED' and v_session.reward_transaction_id is not null then
    return query
      select 'REWARDED', v_session.reward_amount, v_video.currency, v_session.reward_transaction_id,
             v_session.reward_reference, v_session.watched_seconds, null::text, true;
    return;
  end if;
  if v_session.status in ('EXPIRED','REJECTED','SUSPENDED') then
    return query
      select v_session.status, null::numeric, v_video.currency, null::uuid, null::text,
             v_session.watched_seconds, v_session.reject_reason, false;
    return;
  end if;

  -- A session already completed without a reward is terminal too, so collecting
  -- twice cannot count the same view twice. This is the only place that sets
  -- 'COMPLETED', so the status is unambiguous.
  if v_session.status = 'COMPLETED' then
    return query
      select 'NO_REWARD', v_session.reward_amount, v_video.currency, null::uuid, null::text,
             v_session.watched_seconds, null::text, true;
    return;
  end if;

  v_elapsed := extract(epoch from (now() - v_session.started_at));

  -- Watch-time enforcement happens server-side only.
  if v_elapsed < v_session.required_watch_seconds or v_session.watched_seconds < v_session.required_watch_seconds then
    update public.video_watch_sessions
       set status = 'REJECTED',
           reject_reason = 'INSUFFICIENT_WATCH_TIME',
           completed_at = now()
     where id = v_session.id;

    perform public.record_fraud_event(
      p_user_id, 'WATCH_TIME_MISMATCH', 'LOW', 5,
      jsonb_build_object('session_id', v_session.id, 'watched', v_session.watched_seconds,
                         'required', v_session.required_watch_seconds, 'elapsed', v_elapsed)
    );

    return query
      select 'REJECTED', null::numeric, v_video.currency, null::uuid, null::text,
             v_session.watched_seconds, 'INSUFFICIENT_WATCH_TIME', false;
    return;
  end if;

  if v_profile.status <> 'ACTIVE' or v_profile.risk_status in ('RESTRICTED','SUSPENDED') then
    update public.video_watch_sessions
       set status = 'SUSPENDED', reject_reason = 'ACCOUNT_NOT_ELIGIBLE', completed_at = now()
     where id = v_session.id;
    return query
      select 'SUSPENDED', null::numeric, v_video.currency, null::uuid, null::text,
             v_session.watched_seconds, 'ACCOUNT_NOT_ELIGIBLE', false;
    return;
  end if;

  -- Lock the campaign row *before* deciding, so two sessions completing at the
  -- same instant cannot both pass the budget check and jointly overspend it.
  if v_video.campaign_id is not null then
    perform 1 from public.video_campaigns where id = v_video.campaign_id for update;
  end if;

  -- Campaign budget / view ceiling, at the rate this session will actually pay.
  if v_video.status <> 'ACTIVE' or not public.campaign_is_payable(v_video.campaign_id, v_reward) then
    update public.video_watch_sessions
       set status = 'REJECTED', reject_reason = 'CAMPAIGN_BUDGET_EXHAUSTED', completed_at = now()
     where id = v_session.id;
    return query
      select 'REJECTED', null::numeric, v_video.currency, null::uuid, null::text,
             v_session.watched_seconds, 'CAMPAIGN_BUDGET_EXHAUSTED', false;
    return;
  end if;

  -- Platform-wide daily cap per user.
  select count(*) into v_daily
    from public.video_watch_sessions s
   where s.user_id = p_user_id
     and s.status = 'REWARDED'
     and s.rewarded_at >= date_trunc('day', now());
  if v_daily >= public.setting_num('rewards.max_daily_rewarded_sessions', 200) then
    update public.video_watch_sessions
       set status = 'REJECTED', reject_reason = 'DAILY_REWARD_LIMIT', completed_at = now()
     where id = v_session.id;
    return query
      select 'REJECTED', null::numeric, v_video.currency, null::uuid, null::text,
             v_session.watched_seconds, 'DAILY_REWARD_LIMIT', false;
    return;
  end if;

  -- --------------------------------------------------------------------------
  -- The package's daily earning cap.
  --
  -- `earned_today + v_reward > cap` rather than `earned_today >= cap`: the reward
  -- that would take the user *past* the cap is refused whole. Paying a prorated
  -- remnant would put a partial amount in the ledger that no campaign figure
  -- explains, and would let the cap be exceeded one reward at a time.
  --
  -- A session that reaches here is in a genuine race — the same video was
  -- started while there was headroom and another session consumed it first. It is
  -- rejected WITHOUT a fraud event, exactly like the platform daily cap above:
  -- reaching a limit is not misbehaviour.
  -- --------------------------------------------------------------------------
  if v_session.package_id is not null then
    select * into v_usage from public.package_daily_usage(p_user_id, v_session.package_id);

    if not v_usage.has_active_purchase then
      update public.video_watch_sessions
         set status = 'REJECTED',
             reject_reason = case
                               when v_usage.purchase_expired then 'PACKAGE_EXPIRED'
                               else 'PACKAGE_REQUIRED'
                             end,
             completed_at = now()
       where id = v_session.id;
      return query
        select 'REJECTED', null::numeric, v_video.currency, null::uuid, null::text,
               v_session.watched_seconds,
               case
                 when v_usage.purchase_expired then 'PACKAGE_EXPIRED'
                 else 'PACKAGE_REQUIRED'
               end,
               false;
      return;
    end if;

    if v_usage.earned_today + v_reward > v_usage.daily_cap then
      update public.video_watch_sessions
         set status = 'REJECTED', reject_reason = 'PACKAGE_DAILY_LIMIT', completed_at = now()
       where id = v_session.id;
      return query
        select 'REJECTED', null::numeric, v_video.currency, null::uuid, null::text,
               v_session.watched_seconds, 'PACKAGE_DAILY_LIMIT', false;
      return;
    end if;

    /*
      The lifetime ceiling, refused whole for the same reason as the daily one: a
      prorated remnant would put an amount in the ledger that no advertised term
      explains, and would let the ceiling be exceeded one reward at a time.
    */
    if v_usage.lifetime_cap is not null
       and v_usage.earned_total + v_reward > v_usage.lifetime_cap then
      update public.video_watch_sessions
         set status = 'REJECTED', reject_reason = 'PACKAGE_TOTAL_LIMIT', completed_at = now()
       where id = v_session.id;
      return query
        select 'REJECTED', null::numeric, v_video.currency, null::uuid, null::text,
               v_session.watched_seconds, 'PACKAGE_TOTAL_LIMIT', false;
      return;
    end if;
  end if;

  v_ref := 'VRW-' || v_session.id::text;

  -- --------------------------------------------------------------------------
  -- A reward of zero completes without touching the ledger.
  --
  -- Deliberately placed after every gate above, so a zero-reward session is
  -- held to the same watch-time, account, campaign and daily-limit rules as a
  -- paying one. It is not an early exit and cannot be used to skip a check.
  -- --------------------------------------------------------------------------
  if v_reward is null or v_reward = 0 then
    update public.video_watch_sessions
       set status = 'COMPLETED',
           completed_at = now(),
           reward_amount = 0
     where id = v_session.id;

    -- The view still happened, so campaign accounting still counts it.
    update public.videos
       set total_views = total_views + 1
     where id = v_video.id;

    if v_video.campaign_id is not null then
      update public.video_campaigns
         set total_views = total_views + 1
       where id = v_video.campaign_id;
    end if;

    return query
      select 'NO_REWARD', 0::numeric, v_video.currency, null::uuid, null::text,
             v_session.watched_seconds, null::text, false;
    return;
  end if;

  v_tx := public.wallet_post(
    p_user_id     => p_user_id,
    p_type        => 'VIDEO_REWARD',
    p_amount      => v_reward,
    p_status      => 'COMPLETED',
    p_reference   => v_ref,
    p_description => 'Reward for completed video: ' || v_video.title,
    p_metadata    => jsonb_build_object(
                       'video_id', v_video.id,
                       'campaign_id', v_video.campaign_id,
                       'session_id', v_session.id,
                       'package_id', v_session.package_id
                     ),
    p_source      => 'VIDEO'
  );

  update public.video_watch_sessions
     set status = 'REWARDED',
         completed_at = now(),
         rewarded_at = now(),
         reward_amount = v_reward,
         reward_transaction_id = v_tx.id,
         reward_reference = v_ref
   where id = v_session.id;

  -- Campaign accounting so budget can never be silently exceeded.
  update public.videos
     set total_views = total_views + 1
   where id = v_video.id;

  if v_video.campaign_id is not null then
    update public.video_campaigns
       set spent = spent + v_reward,
           total_views = total_views + 1
     where id = v_video.campaign_id
       and spent + v_reward <= budget;

    -- If the ceiling moved while we were paying, roll the whole thing back
    -- rather than crediting a reward the campaign budget cannot cover.
    if not found then
      raise exception 'CAMPAIGN_NOT_PAYABLE' using errcode = 'P0001';
    end if;
  end if;

  perform public.notify_user(
    p_user_id, 'VIDEO_REWARD_CREDITED', 'Reward credited',
    'Your reward of ' || v_video.currency || ' ' || to_char(v_reward, 'FM999,999,990.00') ||
      ' for "' || v_video.title || '" has been added to your wallet.',
    'SUCCESS', '/dashboard/wallet'
  );

  return query
    select 'REWARDED', v_reward, v_video.currency, v_tx.id, v_ref, v_session.watched_seconds, null::text, false;
end;
$$;

revoke all on function public.video_complete_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.video_complete_session(uuid, uuid) to service_role;
