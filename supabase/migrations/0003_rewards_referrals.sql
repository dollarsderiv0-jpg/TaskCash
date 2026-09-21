-- ============================================================================
-- TaskCash Pro — 0003 Video rewards, referrals, user provisioning
--
-- The watch flow is server-authoritative: the client never supplies a reward
-- amount, and the reward is only ever minted inside public.video_complete_session
-- after the server has itself measured elapsed time and enforced every limit.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- user provisioning — one auth user maps to one profile + one wallet
-- ---------------------------------------------------------------------------
create or replace function public.generate_referral_code()
returns text
language plpgsql
volatile
as $$
declare
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code     text;
  i        int;
begin
  for attempt in 1..50 loop
    code := 'TC';
    for i in 1..5 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.profiles p where p.referral_code = code);
  end loop;
  return code;
end;
$$;

create or replace function public.ensure_profile(
  p_auth_user_id uuid,
  p_email        text,
  p_metadata     jsonb default '{}'::jsonb
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile   public.profiles;
  v_currency  text;
  v_country   text;
  v_code      text;
  v_referrer  uuid;
  v_referral  text;
  v_name      text;
  v_phone     text;
begin
  select * into v_profile from public.profiles where auth_user_id = p_auth_user_id;
  if found then
    return v_profile;
  end if;

  perform pg_advisory_xact_lock(hashtext('profile:' || p_auth_user_id::text));

  select * into v_profile from public.profiles where auth_user_id = p_auth_user_id;
  if found then
    return v_profile;
  end if;

  v_country  := upper(coalesce(nullif(trim(p_metadata->>'country'), ''), 'KE'));
  v_currency := upper(coalesce(nullif(trim(p_metadata->>'currency'), ''), 'KES'));
  if not exists (select 1 from public.currencies c where c.code = v_currency and c.enabled) then
    v_currency := 'KES';
  end if;

  v_name  := nullif(trim(coalesce(p_metadata->>'full_name', '')), '');
  v_name  := coalesce(v_name, nullif(split_part(coalesce(p_email, ''), '@', 1), ''), 'TaskCash User');
  v_phone := coalesce(nullif(trim(p_metadata->>'phone'), ''), '');
  v_code  := public.generate_referral_code();

  v_referral := upper(nullif(trim(coalesce(p_metadata->>'referral_code', '')), ''));
  if v_referral is not null then
    select id into v_referrer from public.profiles where referral_code = v_referral;
  end if;

  insert into public.profiles (
    auth_user_id, full_name, email, phone, country, currency, referral_code, referred_by, status
  ) values (
    p_auth_user_id, left(v_name, 120), lower(coalesce(p_email, p_auth_user_id::text || '@placeholder.invalid')),
    v_phone, v_country, v_currency, v_code, v_referrer, 'ACTIVE'
  )
  returning * into v_profile;

  insert into public.wallets (user_id, currency)
  values (v_profile.id, v_currency)
  on conflict (user_id) do nothing;

  -- Record the referral link so the relationship is auditable and unique.
  if v_referrer is not null then
    insert into public.referrals (referrer_id, referred_user_id, referral_code, level, status)
    values (v_referrer, v_profile.id, v_referral, 1, 'PENDING')
    on conflict (referred_user_id) do nothing;

    update public.profiles
       set referred_by = (select referrer_id from public.referrals where referred_user_id = v_profile.id)
     where id = v_profile.id;
  end if;

  perform public.notify_user(
    v_profile.id, 'ACCOUNT_CREATED', 'Welcome to TaskCash Pro',
    'Your account is ready. Complete eligible campaigns to start earning rewards.',
    'SUCCESS', '/dashboard'
  );

  return v_profile;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_profile(new.id, new.email, coalesce(new.raw_user_meta_data, '{}'::jsonb));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.handle_user_email_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email_confirmed_at is not null and old.email_confirmed_at is null then
    update public.profiles
       set email_verified_at = new.email_confirmed_at
     where auth_user_id = new.id;

    perform public.referral_qualify(
      (select id from public.profiles where auth_user_id = new.id),
      'VERIFIED_REGISTRATION'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed
  after update on auth.users
  for each row execute function public.handle_user_email_confirmed();

-- ---------------------------------------------------------------------------
-- campaign eligibility
-- ---------------------------------------------------------------------------
create or replace function public.campaign_is_payable(p_campaign_id uuid, p_reward numeric)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v public.video_campaigns;
begin
  if p_campaign_id is null then
    return true;
  end if;

  select * into v from public.video_campaigns where id = p_campaign_id;
  if not found then
    return false;
  end if;
  if v.status <> 'ACTIVE' then
    return false;
  end if;
  if v.start_at is not null and v.start_at > now() then
    return false;
  end if;
  if v.end_at is not null and v.end_at < now() then
    return false;
  end if;
  if v.max_views is not null and v.total_views >= v.max_views then
    return false;
  end if;
  -- The budget is a hard ceiling: rewards stop when it is exhausted.
  if v.spent + p_reward > v.budget then
    return false;
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- video: start a watch session
-- ---------------------------------------------------------------------------
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
  if not public.campaign_is_payable(v_video.campaign_id, v_video.reward_amount) then
    raise exception 'CAMPAIGN_NOT_PAYABLE' using errcode = 'P0001';
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

  -- Daily per-video limit.
  select count(*) into v_recent
    from public.video_watch_sessions s
   where s.user_id = p_user_id
     and s.video_id = p_video_id
     and s.status = 'REWARDED'
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
       set last_activity_at = now(), status = 'WATCHING'
     where id = v_session.id
     returning * into v_session;

    return query
      select v_session.id, v_session.session_token, v_video.id, v_video.title, v_video.description,
             v_video.video_url, v_video.thumbnail_url, v_video.duration_seconds,
             v_session.required_watch_seconds, v_video.reward_amount, v_video.currency,
             v_session.started_at, v_session.watched_seconds, v_session.status, true;
    return;
  end if;

  insert into public.video_watch_sessions (
    user_id, video_id, required_watch_seconds, ip_hash, device_hash, status
  ) values (
    p_user_id, p_video_id, v_video.required_watch_seconds, p_ip_hash, p_device_hash, 'WATCHING'
  )
  returning * into v_session;

  return query
    select v_session.id, v_session.session_token, v_video.id, v_video.title, v_video.description,
           v_video.video_url, v_video.thumbnail_url, v_video.duration_seconds,
           v_video.required_watch_seconds, v_video.reward_amount, v_video.currency,
           v_session.started_at, v_session.watched_seconds, v_session.status, false;
end;
$$;

-- ---------------------------------------------------------------------------
-- video: report progress (clamped to what the server has actually observed)
-- ---------------------------------------------------------------------------
create or replace function public.video_progress(
  p_user_id         uuid,
  p_session_token   uuid,
  p_watched_seconds numeric
)
returns table (
  watched_seconds        numeric,
  required_watch_seconds int,
  elapsed_seconds        numeric,
  status                 text,
  ready                  boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.video_watch_sessions;
  v_elapsed numeric;
  v_claimed numeric;
begin
  select * into v_session
    from public.video_watch_sessions
   where session_token = p_session_token
     and user_id = p_user_id
   for update;

  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_session.status in ('REWARDED','EXPIRED','REJECTED','SUSPENDED') then
    raise exception 'SESSION_CLOSED' using errcode = 'P0001';
  end if;

  v_elapsed := extract(epoch from (now() - v_session.started_at));
  -- A client cannot claim more watch time than wall-clock time has passed.
  v_claimed := least(greatest(coalesce(p_watched_seconds, 0), 0), v_elapsed + 1.5);

  update public.video_watch_sessions
     set watched_seconds = greatest(watched_seconds, least(v_claimed, v_elapsed + 1.5)),
         last_activity_at = now(),
         status = 'WATCHING'
   where id = v_session.id
   returning * into v_session;

  return query
    select v_session.watched_seconds, v_session.required_watch_seconds, v_elapsed,
           v_session.status,
           (v_session.watched_seconds >= v_session.required_watch_seconds and v_elapsed >= v_session.required_watch_seconds);
end;
$$;

-- ---------------------------------------------------------------------------
-- video: complete + mint the reward. This is the only place a reward exists.
-- ---------------------------------------------------------------------------
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

  -- Campaign budget / view ceiling.
  if v_video.status <> 'ACTIVE' or not public.campaign_is_payable(v_video.campaign_id, v_video.reward_amount) then
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

  -- The reward value is read from the campaign record — never from the client.
  v_reward := v_video.reward_amount;
  v_ref := 'VRW-' || v_session.id::text;

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
                       'session_id', v_session.id
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

-- ---------------------------------------------------------------------------
-- referrals
-- ---------------------------------------------------------------------------
create or replace function public.referral_qualify(
  p_referred_user_id uuid,
  p_event            text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref       public.referrals;
  v_currency  text;
  v_bonus     numeric(20,4);
  v_rate_l1   numeric;
  v_rate_l2   numeric;
begin
  if not public.setting_bool('referrals.enabled', true) then
    return;
  end if;

  select * into v_ref from public.referrals where referred_user_id = p_referred_user_id for update;
  if not found then
    return;
  end if;
  if v_ref.status = 'QUALIFIED' then
    return;
  end if;

  -- Only the configured qualifying event flips a referral to QUALIFIED.
  if public.setting_text('referrals.qualifying_event', 'VERIFIED_REGISTRATION') <> p_event then
    return;
  end if;

  -- Commission rates are read at qualify time and stored on each commission.
  v_rate_l1 := public.setting_num('referrals.level1_rate', 0.05);
  v_rate_l2 := public.setting_num('referrals.level2_rate', 0);
  if v_rate_l1 <= 0 and v_rate_l2 <= 0 then
    -- Referral program is configured off; still record the qualification.
    update public.referrals set status = 'QUALIFIED', qualifying_event = p_event, qualified_at = now()
     where id = v_ref.id;
    return;
  end if;

  update public.referrals
     set status = 'QUALIFIED', qualifying_event = p_event, qualified_at = now()
   where id = v_ref.id;

  select currency into v_currency from public.profiles where id = v_ref.referrer_id;

  v_bonus := public.setting_num('referrals.signup_bonus', 0);
  if v_bonus > 0 and v_rate_l1 > 0 then
    perform public.referral_credit(
      v_ref.referrer_id, v_ref.referred_user_id, 1,
      v_bonus, coalesce(v_currency, 'KES'), 1.0, p_event,
      null, 'REFERRAL_SIGNUP_BONUS'
    );
  end if;

  perform public.notify_user(
    v_ref.referrer_id, 'REFERRAL_QUALIFIED', 'Referral qualified',
    'Someone you invited has qualified under the current referral rules. Commissions will accrue on their eligible activity.',
    'SUCCESS', '/dashboard/referrals'
  );
end;
$$;

create or replace function public.referral_credit(
  p_referrer_id       uuid,
  p_referred_user_id  uuid,
  p_level             int,
  p_base_amount       numeric,
  p_currency          text,
  p_rate              numeric,
  p_event             text,
  p_source_tx_id      uuid,
  p_source_label      text default 'REFERRAL_ACTIVITY'
)
returns public.referral_commissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric(20,4);
  v_row    public.referral_commissions;
  v_tx     public.wallet_transactions;
  v_ref    text;
begin
  if p_referrer_id is null or p_referrer_id = p_referred_user_id then
    return null;
  end if;
  if p_rate <= 0 or p_base_amount <= 0 then
    return null;
  end if;

  -- Round to the currency's minor unit to avoid sub-cent dust.
  v_amount := round(p_base_amount * p_rate, 2);
  if v_amount <= 0 then
    return null;
  end if;

  v_ref := 'RCM-' || p_referrer_id::text || '-' || p_level::text || '-' ||
           coalesce(p_source_tx_id::text, md5(p_event || p_referred_user_id::text));

  insert into public.referral_commissions (
    referrer_id, referred_user_id, amount, currency, level, rate, base_amount,
    status, qualifying_event, source_transaction_id
  ) values (
    p_referrer_id, p_referred_user_id, v_amount, p_currency, p_level, p_rate, p_base_amount,
    'CREDITED', p_event, p_source_tx_id
  )
  on conflict (referrer_id, referred_user_id, level, qualifying_event, source_transaction_id)
  do nothing
  returning * into v_row;

  -- Duplicate commission attempt: nothing was inserted, so credit nothing.
  if not found then
    return null;
  end if;

  v_tx := public.wallet_post(
    p_user_id     => p_referrer_id,
    p_type        => 'REFERRAL_REWARD',
    p_amount      => v_amount,
    p_status      => 'COMPLETED',
    p_reference   => v_ref,
    p_description => 'Referral commission (level ' || p_level::text || ')',
    p_metadata    => jsonb_build_object(
                       'level', p_level,
                       'rate', p_rate,
                       'base_amount', p_base_amount,
                       'referred_user_id', p_referred_user_id,
                       'qualifying_event', p_event,
                       'source', p_source_label
                     ),
    p_source      => 'REFERRAL'
  );

  update public.referral_commissions
     set wallet_transaction_id = v_tx.id, credited_at = now()
   where id = v_row.id
   returning * into v_row;

  perform public.notify_user(
    p_referrer_id, 'REFERRAL_COMMISSION', 'Referral commission credited',
    'You earned ' || p_currency || ' ' || to_char(v_amount, 'FM999,999,990.00') ||
      ' in referral commission.',
    'SUCCESS', '/dashboard/referrals'
  );

  return v_row;
end;
$$;

create or replace function public.referral_commission_on_deposit(
  p_referred_user_id uuid,
  p_source_tx_id     uuid,
  p_base_amount      numeric,
  p_currency         text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref   public.referrals;
  v_l1    uuid;
  v_rate1 numeric;
  v_rate2 numeric;
begin
  if not public.setting_bool('referrals.enabled', true) then
    return;
  end if;
  if not public.setting_bool('referrals.commission_on_deposit', true) then
    return;
  end if;

  select * into v_ref from public.referrals
   where referred_user_id = p_referred_user_id and status = 'QUALIFIED';
  if not found then
    return;
  end if;

  v_rate1 := coalesce(public.setting_num('referrals.level1_rate', 0.05), 0);
  if v_rate1 > 0 then
    perform public.referral_credit(
      v_ref.referrer_id, p_referred_user_id, 1, p_base_amount, p_currency, v_rate1,
      'ELIGIBLE_DEPOSIT', p_source_tx_id
    );
  end if;

  -- Level 2 is supported but off by default.
  v_rate2 := coalesce(public.setting_num('referrals.level2_rate', 0), 0);
  if v_rate2 > 0 then
    select referred_by into v_l1 from public.profiles where id = v_ref.referrer_id;
    if v_l1 is not null then
      perform public.referral_credit(
        v_l1, p_referred_user_id, 2, p_base_amount, p_currency, v_rate2,
        'ELIGIBLE_DEPOSIT', p_source_tx_id
      );
    end if;
  end if;
end;
$$;
