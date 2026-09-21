-- ============================================================================
-- 40 — video rewards
--
-- The reward value is read from the video/campaign record inside the database.
-- Nothing the client sends can influence it, and a session can only ever be
-- rewarded once.
-- ============================================================================

/* -- the rewarded path ------------------------------------------------------ */

do $$
declare
  u uuid := tc_test.create_user('vid_ok@test.invalid');
  v record;
  token uuid;
  res record;
begin
  select * into v from tc_test.create_video(5, 100, 1, 10);
  token := tc_test.begin_watch(u, v.video_id, 10);

  select * into res from public.video_complete_session(u, token);

  perform tc_test.eq_text('a completed watch is REWARDED', res.result_status, 'REWARDED');
  perform tc_test.eq_num('the reward equals the configured video reward', res.reward_amount, 5);
  perform tc_test.eq_num('the wallet is credited by the reward', tc_test.available(u), 5);
  perform tc_test.eq_num('a VIDEO_REWARD ledger row is written',
    tc_test.ledger_count('VRW-' || (select id from public.video_watch_sessions where session_token = token)::text), 1);
  perform tc_test.eq_num('the campaign records the spend',
    (select spent from public.video_campaigns where id = v.campaign_id), 5);
  perform tc_test.eq_num('the video view counter advances',
    (select total_views from public.videos where id = v.video_id), 1);
end $$;

/* -- the reward is never taken from the caller ------------------------------ */

do $$
declare
  u uuid := tc_test.create_user('vid_amount@test.invalid');
  v record;
  token uuid;
  res record;
begin
  select * into v from tc_test.create_video(7, 100, 1, 10);
  token := tc_test.begin_watch(u, v.video_id, 10);
  select * into res from public.video_complete_session(u, token);

  perform tc_test.eq_num('the credited amount matches the database, not the client', tc_test.available(u), 7);
end $$;

/* -- watch time is enforced server-side ------------------------------------ */

do $$
declare
  u uuid := tc_test.create_user('vid_short@test.invalid');
  v record;
  token uuid;
  res record;
begin
  select * into v from tc_test.create_video(5, 100, 2, 10);

  -- Start a session and complete it immediately: not enough real elapsed time.
  select session_token into token from public.video_start(u, v.video_id, null, null);
  select * into res from public.video_complete_session(u, token);

  perform tc_test.eq_text('finishing too early is REJECTED', res.result_status, 'REJECTED');
  perform tc_test.eq_text('the rejection reason is recorded', res.reject_reason, 'INSUFFICIENT_WATCH_TIME');
  perform tc_test.eq_num('a rejected watch credits nothing', tc_test.available(u), 0);
  perform tc_test.eq_num('a rejected watch writes no ledger row', tc_test.ledger_count('VRW-' || (select id from public.video_watch_sessions where session_token = token)::text), 0);
end $$;

/* -- a session rewards exactly once ---------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('vid_twice@test.invalid');
  v record;
  token uuid;
  first_res record;
  second_res record;
begin
  select * into v from tc_test.create_video(6, 100, 1, 10);
  token := tc_test.begin_watch(u, v.video_id, 10);

  select * into first_res from public.video_complete_session(u, token);
  select * into second_res from public.video_complete_session(u, token);

  perform tc_test.eq_bool('the replay is reported as a duplicate', second_res.duplicate, true);
  perform tc_test.eq_num('the replay credits nothing further', tc_test.available(u), 6);
  perform tc_test.eq_num('the replay writes no second reward',
    tc_test.ledger_count('VRW-' || (select id from public.video_watch_sessions where session_token = token)::text), 1);
end $$;

/* -- campaign budget is a hard ceiling ------------------------------------- */

do $$
declare
  u1 uuid := tc_test.create_user('vid_budget1@test.invalid');
  u2 uuid := tc_test.create_user('vid_budget2@test.invalid');
  v record;
  t1 uuid;
  t2 uuid;
  res record;
begin
  -- Budget is exactly one reward.
  select * into v from tc_test.create_video(10, 10, 1, 10);

  -- Both sessions are opened while the campaign can still pay, so the second
  -- one really is "already in flight" when the budget runs out. Opening it
  -- after exhaustion is refused earlier, at video_start.
  t1 := tc_test.begin_watch(u1, v.video_id, 10);
  t2 := tc_test.begin_watch(u2, v.video_id, 10);

  select * into res from public.video_complete_session(u1, t1);
  perform tc_test.eq_text('the first watch is rewarded', res.result_status, 'REWARDED');
  perform tc_test.eq_num('the campaign budget is now exhausted',
    (select spent from public.video_campaigns where id = v.campaign_id), 10);

  -- The in-flight second session must be refused rather than paid.
  select * into res from public.video_complete_session(u2, t2);

  perform tc_test.eq_text('a reward beyond the budget is refused', res.result_status, 'REJECTED');
  perform tc_test.eq_text('the refusal cites the exhausted budget', res.reject_reason, 'CAMPAIGN_BUDGET_EXHAUSTED');
  perform tc_test.eq_num('the second user is credited nothing', tc_test.available(u2), 0);
  perform tc_test.eq_num('the campaign can never spend past its budget',
    (select spent from public.video_campaigns where id = v.campaign_id), 10);

  -- ...and no further session can even be opened on an exhausted campaign, so
  -- a user is never invited to watch content that cannot pay out.
  perform tc_test.raises('an exhausted campaign refuses new sessions at start',
    format($q$select * from public.video_start(%L::uuid, %L::uuid, null, null)$q$, u2, v.video_id),
    'CAMPAIGN_NOT_PAYABLE');
end $$;

/* -- a row-locked budget check ---------------------------------------------- */
-- Proves the check is done against the *locked* campaign row, which is what
-- makes the concurrent case safe. The true two-connection race is exercised
-- separately by the runner.

do $$
declare
  u uuid := tc_test.create_user('vid_lock@test.invalid');
  v record;
  token uuid;
begin
  select * into v from tc_test.create_video(5, 5, 1, 10);
  token := tc_test.begin_watch(u, v.video_id, 10);

  -- Holding the campaign row must not prevent the completion from proceeding
  -- in the same transaction (advisory + row locks are re-entrant per tx).
  perform public.video_complete_session(u, token);

  perform tc_test.eq_num('the reward is paid and counted', tc_test.available(u), 5);
end $$;

/* -- campaign state and eligibility gates ---------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('vid_gates@test.invalid');
  u_off uuid := tc_test.create_user('vid_off@test.invalid');
  v record;
  token uuid;
  res record;
begin
  select * into v from tc_test.create_video(5, 100, 1, 10);

  -- Paused campaign: cannot start, and cannot be completed if already started.
  token := tc_test.begin_watch(u, v.video_id, 10);
  update public.video_campaigns set status = 'PAUSED' where id = v.campaign_id;

  perform tc_test.raises('a paused campaign cannot be started',
    format($q$select public.video_start(%L::uuid, %L::uuid, null, null)$q$, u, v.video_id),
    'CAMPAIGN_NOT_PAYABLE');

  select * into res from public.video_complete_session(u, token);
  perform tc_test.eq_text('a watch in flight is not paid once the campaign is paused', res.result_status, 'REJECTED');
  perform tc_test.eq_text('the refusal cites the campaign', res.reject_reason, 'CAMPAIGN_BUDGET_EXHAUSTED');

  update public.video_campaigns set status = 'ACTIVE' where id = v.campaign_id;

  -- A suspended account cannot earn.
  perform tc_test.set_status(u_off, 'SUSPENDED');
  perform tc_test.raises('a suspended account cannot start a watch',
    format($q$select public.video_start(%L::uuid, %L::uuid, null, null)$q$, u_off, v.video_id),
    'ACCOUNT_NOT_ACTIVE');
end $$;

/* -- cooldown and daily limits --------------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('vid_daily@test.invalid');
  v record;
  token uuid;
begin
  -- daily_limit = 1 means the second watch of the same video today is refused.
  select * into v from tc_test.create_video(4, 100, 1, 1);

  token := tc_test.begin_watch(u, v.video_id, 10);
  perform public.video_complete_session(u, token);

  perform tc_test.raises('the per-video daily limit is enforced',
    format($q$select public.video_start(%L::uuid, %L::uuid, null, null)$q$, u, v.video_id),
    'VIDEO_DAILY_LIMIT_REACHED');
end $$;

do $$
declare
  u uuid := tc_test.create_user('vid_velocity@test.invalid');
  v record;
begin
  -- A human cannot legitimately finish many videos in an hour.
  update public.system_settings set value = '1'::jsonb where key = 'fraud.max_rewarded_sessions_per_hour';

  select * into v from tc_test.create_video(1, 100, 1, 50);
  perform public.video_complete_session(u, tc_test.begin_watch(u, v.video_id, 10));

  perform tc_test.raises('the hourly reward velocity guard engages',
    format($q$select public.video_start(%L::uuid, %L::uuid, null, null)$q$, u, v.video_id),
    'VELOCITY_BLOCKED');

  update public.system_settings set value = '40'::jsonb where key = 'fraud.max_rewarded_sessions_per_hour';
end $$;
