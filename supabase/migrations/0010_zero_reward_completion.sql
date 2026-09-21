-- ============================================================================
-- 0010 — completing a video that pays no reward
--
-- WHY THIS EXISTS
--
-- public.video_complete_session() posts the reward through public.wallet_post(),
-- which rejects a non-positive amount:
--
--     when 'DEPOSIT', 'VIDEO_REWARD', ... then
--       if p_amount <= 0 then raise exception 'LEDGER_AMOUNT_INVALID';
--
-- A video whose reward_amount is 0 gets past the campaign budget gate
-- (campaign_is_payable checks `spent + reward > budget`, and 0 + 0 > 0 is false)
-- and then RAISES inside wallet_post. The transaction aborts, the session is
-- left in WATCHING, and the caller sees a server error.
--
-- That makes a legitimate case impossible: a campaign that shows content without
-- paying for it. A brand-awareness or house campaign has a real reward of zero,
-- and a user who watches it should be told exactly that — "no reward for this
-- video" — not handed an error. Without this branch, the /dashboard/watch
-- "Collect reward" button can only ever fail on such a video.
--
-- WHAT IT DOES NOT CHANGE
--
-- Every gate stays exactly as it was and is still evaluated in the same order:
-- the advisory lock, the idempotency guards, the server-side watch-time check
-- (which still files WATCH_TIME_MISMATCH), the account-status check, the
-- campaign lock, the budget ceiling, and the daily cap. Only the final step
-- differs: a zero reward completes the session with NO ledger row instead of
-- posting one.
--
-- NO MONEY IS CREATED HERE. The zero-reward path writes no wallet_transactions
-- row, touches no balance, and sends no "reward credited" notification. It only
-- marks the session and counts the view.
--
-- Also added: a terminal guard for status 'COMPLETED'. Nothing in this schema
-- sets that status (the vocabulary allows it but no code path used it), so it is
-- safe to claim as the zero-reward terminal state — and it stops a second
-- collect from counting the same view twice.
--
-- Applied via supabase/apply-all.sql (regenerate with `npm run db:bundle`), or
-- copy this file into the SQL editor on the TaskCash Pro project.
-- ============================================================================

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

  -- --------------------------------------------------------------------------
  -- NEW IN 0010: a reward of zero completes without touching the ledger.
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

-- CREATE OR REPLACE preserves the existing ACL, so this is belt-and-braces: the
-- financial function must never become callable from a user session, and
-- re-asserting it here means a future drop/recreate cannot quietly regrant it.
revoke all on function public.video_complete_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.video_complete_session(uuid, uuid) to service_role;
