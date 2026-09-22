-- ============================================================================
-- 70 — packages: purchase, daily earning cap, and the day boundary
--
-- What is being proved here is that the cap is a *money* rule rather than a
-- screen rule: it holds when the API is bypassed, it cannot be exceeded by
-- starting two sessions, and it cannot be reset by editing anything a user can
-- reach.
-- ============================================================================

/* -- a video in no package is unaffected ----------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('pkg_free@test.invalid');
  v record;
  token uuid;
  res record;
begin
  select * into v from tc_test.create_video(5, 100, 1, 10);
  token := tc_test.begin_watch(u, v.video_id, 10);
  select * into res from public.video_complete_session(u, token);

  perform tc_test.eq_text('a video in no package still rewards without a purchase',
    res.result_status, 'REWARDED');
  perform tc_test.eq_num('and it credits the normal reward', tc_test.available(u), 5);
end $$;

/* -- a package video needs the package -------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('pkg_required@test.invalid');
  p uuid := tc_test.create_package(800, 100);
  v record;
begin
  select * into v from tc_test.create_video(5, 100, 1, 10);
  perform tc_test.attach_video(p, v.video_id);

  perform tc_test.raises('a package video cannot be started without the package',
    format($q$select * from public.video_start(%L::uuid, %L::uuid)$q$, u, v.video_id),
    'PACKAGE_REQUIRED');
end $$;

/* -- buying ------------------------------------------------------------------ */

do $$
declare
  u uuid := tc_test.create_user('pkg_buy@test.invalid');
  p uuid := tc_test.create_package(800, 100);
  res record;
  tx record;
begin
  perform tc_test.fund(u, 1000);

  select * into res from public.package_purchase(u, p);

  perform tc_test.eq_num('the package price leaves the wallet', tc_test.available(u), 200);
  perform tc_test.eq_num('the response reports the authoritative post-purchase balance',
    res.available_balance, 200);
  perform tc_test.eq_num('the price charged is the package price', res.price_paid, 800);
  perform tc_test.eq_num('the cap on the purchase is the package cap', res.daily_earning_cap, 100);

  select * into tx from public.wallet_transactions where reference = res.reference;
  perform tc_test.eq_text('the ledger row is a PACKAGE_PURCHASE', tx.type, 'PACKAGE_PURCHASE');
  perform tc_test.eq_text('it is a debit', tx.direction, 'DEBIT');
  perform tc_test.eq_num('it debits exactly the price', tx.available_delta, -800);
  perform tc_test.eq_num('it locks nothing', tx.locked_delta, 0);
  perform tc_test.eq_num('the purchase records its ledger row',
    (select count(*)::int from public.user_packages
      where id = res.purchase_id and purchase_transaction_id = tx.id), 1);
  perform tc_test.eq_num('the purchase is audited',
    (select count(*)::int from public.audit_logs
      where action = 'PACKAGE_PURCHASED' and entity_id = res.purchase_id::text), 1);
end $$;

/* -- refusals ---------------------------------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('pkg_refuse@test.invalid');
  u_poor uuid := tc_test.create_user('pkg_poor@test.invalid');
  p_draft uuid := tc_test.create_package(800, 100, 'DRAFT');
  p_nocap uuid := tc_test.create_package(800, 0);
  p_ok uuid := tc_test.create_package(800, 100);
  rows_left int;
  tx_left int;
begin
  perform tc_test.fund(u, 1000);

  perform tc_test.raises('a DRAFT package cannot be bought',
    format($q$select * from public.package_purchase(%L::uuid, %L::uuid)$q$, u, p_draft),
    'PACKAGE_NOT_AVAILABLE');

  -- The cap IS the earning allowance. Selling a package without one would take
  -- the money and give nothing, so an unconfigured cap fails closed.
  perform tc_test.raises('a package with no earning cap cannot be bought',
    format($q$select * from public.package_purchase(%L::uuid, %L::uuid)$q$, u, p_nocap),
    'PACKAGE_NOT_AVAILABLE');

  perform tc_test.raises('a wallet without the price is refused',
    format($q$select * from public.package_purchase(%L::uuid, %L::uuid)$q$, u_poor, p_ok),
    'INSUFFICIENT_AVAILABLE_BALANCE');

  select count(*)::int into rows_left from public.user_packages where user_id = u_poor;
  select count(*)::int into tx_left from public.wallet_transactions
   where user_id = u_poor and type = 'PACKAGE_PURCHASE';
  perform tc_test.eq_num('a refused purchase leaves no purchase row', rows_left, 0);
  perform tc_test.eq_num('a refused purchase leaves no ledger row', tx_left, 0);

  perform public.package_purchase(u, p_ok);
  perform tc_test.raises('the same package cannot be bought twice while active',
    format($q$select * from public.package_purchase(%L::uuid, %L::uuid)$q$, u, p_ok),
    'PACKAGE_ALREADY_ACTIVE');
  perform tc_test.eq_num('the failure did not debit a second time', tc_test.available(u), 200);
end $$;

do $$
declare
  u uuid := tc_test.create_user('pkg_frozen@test.invalid');
  p uuid := tc_test.create_package(800, 100);
begin
  perform tc_test.fund(u, 1000);
  update public.wallets set status = 'FROZEN' where user_id = u;

  perform tc_test.raises('a frozen wallet cannot buy a package',
    format($q$select * from public.package_purchase(%L::uuid, %L::uuid)$q$, u, p),
    'WALLET_FROZEN');
end $$;

do $$
declare
  u uuid := tc_test.create_user('pkg_currency@test.invalid');
  p uuid := tc_test.create_package(800, 100);
begin
  -- USD is already seeded by 0005; the point is that the package's currency
  -- disagrees with the wallet's, so the debit would be the wrong number.
  update public.packages set currency = 'USD' where id = p;
  perform tc_test.fund(u, 1000);

  perform tc_test.raises('a package priced in another currency cannot be bought',
    format($q$select * from public.package_purchase(%L::uuid, %L::uuid)$q$, u, p),
    'PACKAGE_CURRENCY_MISMATCH');
end $$;

/* -- the cap ----------------------------------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('pkg_cap@test.invalid');
  p uuid := tc_test.create_package(800, 10);
  v_a record;
  v_b record;
  v_c record;
  token_a uuid;
  token_b uuid;
  res_a record;
  res_b record;
  usage record;
begin
  perform tc_test.fund(u, 1000);
  perform public.package_purchase(u, p);

  select * into v_a from tc_test.create_video(6, 100, 1, 10);
  select * into v_b from tc_test.create_video(4, 100, 1, 10);
  select * into v_c from tc_test.create_video(1, 100, 1, 10);
  perform tc_test.attach_video(p, v_a.video_id);
  perform tc_test.attach_video(p, v_b.video_id);
  perform tc_test.attach_video(p, v_c.video_id);

  /* first reward: 6 of a 10 allowance */
  token_a := tc_test.begin_watch(u, v_a.video_id, 10);
  select * into res_a from public.video_complete_session(u, token_a);
  select * into usage from public.package_daily_usage(u, p);

  perform tc_test.eq_text('a package video rewards once bought', res_a.result_status, 'REWARDED');
  perform tc_test.eq_num('the reward is credited', tc_test.available(u), 206);
  perform tc_test.eq_num('the day usage counts the reward', usage.earned_today, 6);
  perform tc_test.eq_num('the remaining allowance is reported', usage.remaining, 4);
  perform tc_test.eq_num('the cap reported is the package cap', usage.daily_cap, 10);
  perform tc_test.eq_bool('the purchase is reported as active', usage.has_active_purchase, true);

  /*
    The second reward fills the cap EXACTLY (6 + 4 = 10). Allowed: the rule is
    "may not go past", not "may not reach".
  */
  token_b := tc_test.begin_watch(u, v_b.video_id, 10);
  select * into res_b from public.video_complete_session(u, token_b);
  select * into usage from public.package_daily_usage(u, p);

  perform tc_test.eq_text('a reward that exactly fills the cap is paid', res_b.result_status, 'REWARDED');
  perform tc_test.eq_num('the allowance is now spent', usage.remaining, 0);
  perform tc_test.eq_num('and the balance reflects both rewards', tc_test.available(u), 210);

  /* with the allowance spent, the next session cannot even start */
  perform tc_test.raises('a session cannot start once the cap is reached',
    format($q$select * from public.video_start(%L::uuid, %L::uuid)$q$, u, v_c.video_id),
    'PACKAGE_DAILY_LIMIT_REACHED');

  perform tc_test.eq_num('and nothing extra was earned', tc_test.available(u), 210);
end $$;

/* -- a reward cannot push past the cap, even in a race ----------------------- */

do $$
declare
  u uuid := tc_test.create_user('pkg_overshoot@test.invalid');
  p uuid := tc_test.create_package(800, 10);
  v_a record;
  v_b record;
  token_a uuid;
  token_b uuid;
  res_b record;
  usage record;
begin
  perform tc_test.fund(u, 1000);
  perform public.package_purchase(u, p);

  select * into v_a from tc_test.create_video(6, 100, 1, 10);
  select * into v_b from tc_test.create_video(6, 100, 1, 10);
  perform tc_test.attach_video(p, v_a.video_id);
  perform tc_test.attach_video(p, v_b.video_id);

  /* 6 of 10 earned. The second session starts while headroom remains... */
  token_a := tc_test.begin_watch(u, v_a.video_id, 10);
  perform public.video_complete_session(u, token_a);
  token_b := tc_test.begin_watch(u, v_b.video_id, 10);

  /* ...but completing it would take the total to 12 > 10, so the reward is
     refused WHOLE rather than paid in part. */
  select * into res_b from public.video_complete_session(u, token_b);
  select * into usage from public.package_daily_usage(u, p);

  perform tc_test.eq_text('a reward that would exceed the cap is refused',
    res_b.result_status, 'REJECTED');
  perform tc_test.eq_text('with a reason the UI can turn into a countdown',
    res_b.reject_reason, 'PACKAGE_DAILY_LIMIT');
  perform tc_test.eq_num('no partial reward is paid', tc_test.available(u), 206);
  perform tc_test.eq_num('the cap was not exceeded', usage.earned_today, 6);

  perform tc_test.eq_num('reaching the cap is not treated as fraud',
    (select count(*)::int from public.fraud_events
      where user_id = u and event_type = 'WATCH_TIME_MISMATCH'), 0);
end $$;

/* -- the reset ---------------------------------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('pkg_reset@test.invalid');
  p uuid := tc_test.create_package(800, 10);
  v_a record;
  v_b record;
  token_a uuid;
  token_b uuid;
  res_b record;
  usage record;
begin
  perform tc_test.fund(u, 1000);
  perform public.package_purchase(u, p);

  select * into v_a from tc_test.create_video(10, 100, 1, 10);
  select * into v_b from tc_test.create_video(10, 100, 1, 10);
  perform tc_test.attach_video(p, v_a.video_id);
  perform tc_test.attach_video(p, v_b.video_id);

  token_a := tc_test.begin_watch(u, v_a.video_id, 10);
  perform public.video_complete_session(u, token_a);

  perform tc_test.raises('the allowance is spent for today',
    format($q$select * from public.video_start(%L::uuid, %L::uuid)$q$, u, v_b.video_id),
    'PACKAGE_DAILY_LIMIT_REACHED');

  /* Push that reward back a day: it belongs to yesterday's allowance. */
  perform tc_test.backdate_reward(token_a, 1);
  select * into usage from public.package_daily_usage(u, p);

  perform tc_test.eq_num('yesterday''s reward does not count against today', usage.earned_today, 0);
  perform tc_test.eq_num('so the full allowance is available again', usage.remaining, 10);

  token_b := tc_test.begin_watch(u, v_b.video_id, 10);
  select * into res_b from public.video_complete_session(u, token_b);
  perform tc_test.eq_text('and a new day earns again', res_b.result_status, 'REWARDED');
end $$;

/* -- the window is the operator's midnight, not UTC midnight ----------------- */

do $$
declare
  u uuid := tc_test.create_user('pkg_window@test.invalid');
  p uuid := tc_test.create_package(800, 10);
  usage record;
begin
  perform tc_test.fund(u, 1000);
  perform public.package_purchase(u, p);
  select * into usage from public.package_daily_usage(u, p);

  perform tc_test.eq_bool('the reset instant is the start of tomorrow, in Africa/Nairobi',
    usage.resets_at = public.day_start_eat(now()) + interval '1 day', true);
  perform tc_test.eq_text('which is midnight local time',
    to_char(usage.resets_at at time zone 'Africa/Nairobi', 'HH24:MI:SS'), '00:00:00');
  perform tc_test.eq_num('and the window is exactly one day wide',
    extract(epoch from (usage.resets_at - public.day_start_eat(now()))), 86400);
end $$;

/* -- the cap is a snapshot, not a live lookup -------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('pkg_snapshot@test.invalid');
  p uuid := tc_test.create_package(800, 10);
  usage record;
begin
  perform tc_test.fund(u, 1000);
  perform public.package_purchase(u, p);

  /* The operator lowers the tier's cap after the sale. */
  update public.packages set daily_earning_cap = 1 where id = p;
  select * into usage from public.package_daily_usage(u, p);

  perform tc_test.eq_num('a later cap change does not rewrite what the user bought',
    usage.daily_cap, 10);
end $$;

/* -- one video, many packages, a rate each (0020) ---------------------------- */

/*
  The old rule was "a video belongs to at most one package", and the reason given
  was that a user holding both could earn against whichever cap suited them and
  the two allowances would add up. 0020 REVERSES that on purpose: the catalogue is
  shared, a tier carries its own rate, and a buyer holding two tiers legitimately
  earns under both — they paid for both. What must not happen is one tier paying
  another tier's rate, or the campaign being overpaid.
*/

do $$
declare
  p1 uuid := tc_test.create_package(800, 100);
  p2 uuid := tc_test.create_package(2500, 100);
  v record;
  v_msg text := 'NO ERROR RAISED';
begin
  select * into v from tc_test.create_video(5, 1000, 1, 10);
  perform tc_test.attach_video(p1, v.video_id, 5);

  begin
    perform tc_test.attach_video(p2, v.video_id, 30);
  exception when others then
    v_msg := sqlerrm;
  end;

  perform tc_test.eq_text('a video can now be attached to a second package',
    v_msg, 'NO ERROR RAISED');

  perform tc_test.eq_num('…and the two rows carry their own rates',
    (select count(*) from public.package_videos where video_id = v.video_id and reward_amount = 30),
    1);
end $$;

/* -- the viewer is paid the rate of the best tier they hold ------------------ */

do $$
declare
  u uuid := tc_test.create_user('pkg_rates@test.invalid');
  p_small uuid := tc_test.create_package(800, 100);
  p_big   uuid := tc_test.create_package(2500, 100);
  v record;
  token uuid;
  res record;
  retry_msg text := 'NO ERROR RAISED';
begin
  select * into v from tc_test.create_video(5, 1000, 1, 1);
  perform tc_test.attach_video(p_small, v.video_id, 5);
  perform tc_test.attach_video(p_big, v.video_id, 30);

  perform tc_test.fund(u, 10000);
  perform public.package_purchase(u, p_small);

  /*
    Holding only the small tier: the SAME video must pay 5, not 30. This is the
    assertion that would have caught a rate read from the wrong side of the join.
  */
  token := tc_test.begin_watch(u, v.video_id, 10);
  select * into res from public.video_complete_session(u, token);
  perform tc_test.eq_num('holding only the entry tier pays the entry rate', res.reward_amount, 5);
  -- 10,000 funded, less the 800 tier, plus the 5 reward.
  perform tc_test.eq_num('…and the balance reflects that rate', tc_test.available(u), 9205);

  /*
    Now buy the top tier. The per-video daily limit is scoped to the package, so
    the same video is earnable AGAIN under the tier that pays more — which is the
    entire point of a shared catalogue.
  */
  perform public.package_purchase(u, p_big);

  begin
    token := tc_test.begin_watch(u, v.video_id, 10);
    select * into res from public.video_complete_session(u, token);
  exception when others then
    retry_msg := sqlerrm;
  end;

  perform tc_test.eq_text('the same video is earnable again under the higher tier',
    retry_msg, 'NO ERROR RAISED');
  perform tc_test.eq_num('…and it pays the higher tier''s own rate', res.reward_amount, 30);
  -- …less the 2,500 tier, plus the 30 reward.
  perform tc_test.eq_num('…not the rate of the tier whose limit was already spent',
    tc_test.available(u), 6735);
end $$;

/* -- a package row with no rate falls back to the video's own figure ---------- */

do $$
declare
  u uuid := tc_test.create_user('pkg_legacy_rate@test.invalid');
  p uuid := tc_test.create_package(800, 100);
  v record;
  token uuid;
  res record;
begin
  select * into v from tc_test.create_video(7, 1000, 1, 10);
  perform tc_test.attach_video(p, v.video_id);   -- no rate: the pre-0020 shape

  perform tc_test.fund(u, 10000);
  perform public.package_purchase(u, p);

  token := tc_test.begin_watch(u, v.video_id, 10);
  select * into res from public.video_complete_session(u, token);

  perform tc_test.eq_num('a package row with no rate keeps paying the video''s reward',
    res.reward_amount, 7);
end $$;

/* -- the functions are not callable from a user session ---------------------- */

do $$
declare
  u uuid := tc_test.create_user('pkg_acl@test.invalid');
  p uuid := tc_test.create_package(800, 10);
  v_auth uuid := (select auth_user_id from public.profiles where id = u);
  msg_buy text;
  msg_usage text;
  msg_create text;
  msg_attach text;
  msg_grant text;
  msg_raise text;
  before_cap numeric;
  after_cap numeric;
  can_switch boolean;
begin
  begin
    set local role authenticated;
    reset role;
    can_switch := true;
  exception when others then
    can_switch := false;
  end;

  if not can_switch then
    perform tc_test.skip('package RLS probes',
      'the connecting role cannot SET ROLE authenticated (expected on some managed databases)');
    return;
  end if;

  perform tc_test.fund(u, 1000);
  perform public.package_purchase(u, p);
  select daily_earning_cap into before_cap from public.user_packages where user_id = u;

  /*
    Everything attempted as `authenticated` is captured into variables and the
    role is reset BEFORE any assertion runs. `set local role` lasts until the end
    of the transaction, not the end of the block, and tc_test.* lives in its own
    schema — so calling an assertion while still authenticated fails with
    "permission denied for schema tc_test" and reports the wrong problem
    entirely. 60_security.sql structures its probes the same way for this reason.
  */
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_auth::text, true);

  msg_buy := 'NO ERROR RAISED';
  begin
    perform public.package_purchase(u, p);
  exception when others then
    msg_buy := sqlerrm;
  end;

  msg_usage := 'NO ERROR RAISED';
  begin
    perform public.package_daily_usage(u, p);
  exception when others then
    msg_usage := sqlerrm;
  end;

  msg_create := 'NO ERROR RAISED';
  begin
    insert into public.packages (name, price, currency, daily_earning_cap, status)
    values ('Client tier', 1, 'KES', 1, 'ACTIVE');
  exception when others then
    msg_create := sqlerrm;
  end;

  msg_attach := 'NO ERROR RAISED';
  begin
    insert into public.package_videos (package_id, video_id)
    select p, id from public.videos limit 1;
  exception when others then
    msg_attach := sqlerrm;
  end;

  msg_grant := 'NO ERROR RAISED';
  begin
    insert into public.user_packages (user_id, package_id, price_paid, currency,
                                      daily_earning_cap, purchase_reference)
    values (u, p, 0, 'KES', 999999, 'SELFGRANT-1');
  exception when others then
    msg_grant := sqlerrm;
  end;

  /* Raising your own cap is the direct attack on the daily limit. */
  msg_raise := 'NO ERROR RAISED';
  begin
    update public.user_packages set daily_earning_cap = 999999 where user_id = u;
    if not found then msg_raise := 'NO ERROR RAISED'; end if;
  exception when others then
    msg_raise := sqlerrm;
  end;

  reset role;

  perform tc_test.ok('a signed-in user cannot buy a package directly',
    position('permission denied' in lower(msg_buy)) > 0, msg_buy);
  perform tc_test.ok('a signed-in user cannot read package usage directly',
    position('permission denied' in lower(msg_usage)) > 0, msg_usage);
  perform tc_test.ok('a signed-in user cannot create a package',
    position('permission denied' in lower(msg_create)) > 0, msg_create);
  perform tc_test.ok('a signed-in user cannot attach a video to a package',
    position('permission denied' in lower(msg_attach)) > 0, msg_attach);
  perform tc_test.ok('a signed-in user cannot grant themselves a package',
    position('permission denied' in lower(msg_grant)) > 0, msg_grant);
  perform tc_test.ok('a signed-in user cannot raise their own cap',
    position('permission denied' in lower(msg_raise)) > 0, msg_raise);

  select daily_earning_cap into after_cap from public.user_packages where user_id = u;
  perform tc_test.eq_num('and the cap is unchanged afterwards', after_cap, before_cap);
end $$;

/* -- another user's purchases are invisible ---------------------------------- */

do $$
declare
  u1 uuid := tc_test.create_user('pkg_owner@test.invalid');
  u2 uuid := tc_test.create_user('pkg_other@test.invalid');
  p uuid := tc_test.create_package(800, 10);
  v_auth uuid := (select auth_user_id from public.profiles where id = u1);
  mine int;
  theirs int;
  can_switch boolean;
begin
  begin
    set local role authenticated;
    reset role;
    can_switch := true;
  exception when others then
    can_switch := false;
  end;

  if not can_switch then
    perform tc_test.skip('package cross-user visibility', 'cannot SET ROLE authenticated');
    return;
  end if;

  perform tc_test.fund(u1, 1000);
  perform public.package_purchase(u1, p);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_auth::text, true);

  select count(*)::int into mine from public.user_packages where user_id = u1;
  select count(*)::int into theirs from public.user_packages where user_id = u2;

  reset role;

  perform tc_test.eq_num('a user sees their own purchase', mine, 1);
  perform tc_test.eq_num('and none of anyone else''s', theirs, 0);
end $$;

/* -- anonymous ----------------------------------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('pkg_anon@test.invalid');
  p uuid := tc_test.create_package(800, 10);
  pkg_msg text := 'NO ERROR RAISED';
  up_msg text := 'NO ERROR RAISED';
  can_switch boolean;
begin
  begin
    set local role anon;
    reset role;
    can_switch := true;
  exception when others then
    can_switch := false;
  end;

  if not can_switch then
    perform tc_test.skip('package anonymous probes', 'cannot SET ROLE anon');
    return;
  end if;

  perform tc_test.fund(u, 1000);
  perform public.package_purchase(u, p);

  set local role anon;

  begin
    perform count(*) from public.packages;
  exception when others then
    pkg_msg := sqlerrm;
  end;

  begin
    perform count(*) from public.user_packages;
  exception when others then
    up_msg := sqlerrm;
  end;

  reset role;

  /*
    0014 revokes SELECT from anon explicitly rather than relying on the absence
    of a grant: Supabase grants on new tables in the public schema by default, so
    "no policy" would leave this readable and only RLS would hide the rows.
  */
  perform tc_test.ok('an anonymous visitor cannot read the package catalogue',
    position('permission denied' in lower(pkg_msg)) > 0, pkg_msg);
  perform tc_test.ok('an anonymous visitor cannot read purchases',
    position('permission denied' in lower(up_msg)) > 0, up_msg);
end $$;
