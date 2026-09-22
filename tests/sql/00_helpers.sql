-- ============================================================================
-- tc_test — assertion layer + fixtures for the TaskCash Pro money suite
--
-- No extensions required (no pgTAP): assertions write rows, the Node runner
-- reads them back and reports. Everything runs inside one transaction that is
-- rolled back at the end, so a run leaves the database exactly as it found it.
-- ============================================================================

create schema if not exists tc_test;

create table if not exists tc_test.results (
  id         bigserial primary key,
  file       text,
  label      text not null,
  ok         boolean not null,
  skipped    boolean not null default false,
  detail     text
);

/* -------------------------------------------------------------------------- */
/* Assertions                                                                  */
/* -------------------------------------------------------------------------- */

create or replace function tc_test.ok(p_label text, p_condition boolean, p_detail text default null)
returns void
language sql
as $$
  insert into tc_test.results (file, label, ok, detail)
  values (current_setting('tc_test.file', true), p_label, coalesce(p_condition, false), p_detail);
$$;

create or replace function tc_test.skip(p_label text, p_detail text)
returns void
language sql
as $$
  insert into tc_test.results (file, label, ok, skipped, detail)
  values (current_setting('tc_test.file', true), p_label, true, true, p_detail);
$$;

create or replace function tc_test.eq_num(p_label text, p_actual numeric, p_expected numeric)
returns void
language sql
as $$
  insert into tc_test.results (file, label, ok, detail)
  values (
    current_setting('tc_test.file', true), p_label,
    coalesce(p_actual, '-Infinity'::numeric) = p_expected,
    case when coalesce(p_actual, '-Infinity'::numeric) = p_expected
         then null else format('expected %s, got %s', p_expected, coalesce(p_actual::text, 'NULL')) end
  );
$$;

create or replace function tc_test.eq_text(p_label text, p_actual text, p_expected text)
returns void
language sql
as $$
  insert into tc_test.results (file, label, ok, detail)
  values (
    current_setting('tc_test.file', true), p_label,
    coalesce(p_actual, '<null>') = coalesce(p_expected, '<null>'),
    case when coalesce(p_actual, '<null>') = coalesce(p_expected, '<null>')
         then null else format('expected %L, got %L', p_expected, p_actual) end
  );
$$;

create or replace function tc_test.eq_bool(p_label text, p_actual boolean, p_expected boolean)
returns void
language sql
as $$
  insert into tc_test.results (file, label, ok, detail)
  values (
    current_setting('tc_test.file', true), p_label,
    coalesce(p_actual, false) = p_expected,
    case when coalesce(p_actual, false) = p_expected
         then null else format('expected %s, got %s', p_expected, p_actual) end
  );
$$;

/**
 * Asserts that a statement raises, and that the message contains p_token.
 * Used to prove the database refuses the things it must refuse.
 */
create or replace function tc_test.raises(p_label text, p_sql text, p_token text)
returns void
language plpgsql
as $$
declare
  v_msg text;
begin
  begin
    execute p_sql;
    insert into tc_test.results (file, label, ok, detail)
    values (current_setting('tc_test.file', true), p_label, false,
            format('expected an error containing %L, but the statement SUCCEEDED', p_token));
    return;
  exception when others then
    v_msg := sqlerrm;
  end;

  insert into tc_test.results (file, label, ok, detail)
  values (
    current_setting('tc_test.file', true), p_label,
    position(p_token in v_msg) > 0,
    case when position(p_token in v_msg) > 0
         then null else format('expected %L, got %L', p_token, v_msg) end
  );
end;
$$;

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Creates an auth user. The `on_auth_user_created` trigger provisions the
 * profile and wallet, so this doubles as a test of the real provisioning path.
 */
create or replace function tc_test.create_user(
  p_email  text,
  p_meta   jsonb default '{}'::jsonb,
  p_confirm boolean default false
)
returns uuid
language plpgsql
as $$
declare
  v_auth uuid;
begin
  insert into auth.users (email, raw_user_meta_data, email_confirmed_at)
  values (
    p_email,
    coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('full_name', 'Test User', 'country', 'KE', 'currency', 'KES'),
    case when p_confirm then now() else null end
  )
  returning id into v_auth;

  return (select id from public.profiles where auth_user_id = v_auth);
end;
$$;

/** Flips email_confirmed_at, which is what triggers referral qualification. */
create or replace function tc_test.confirm_email(p_profile uuid)
returns void
language plpgsql
as $$
begin
  update auth.users
     set email_confirmed_at = now()
   where id = (select auth_user_id from public.profiles where id = p_profile);
end;
$$;

create or replace function tc_test.set_status(p_profile uuid, p_status text)
returns void
language sql
as $$
  update public.profiles set status = p_status where id = p_profile;
$$;

create or replace function tc_test.available(p_profile uuid)
returns numeric
language sql
as $$
  select available_balance from public.wallets where user_id = p_profile;
$$;

create or replace function tc_test.locked(p_profile uuid)
returns numeric
language sql
as $$
  select locked_balance from public.wallets where user_id = p_profile;
$$;

/** Credits a wallet directly through the ledger (test convenience). */
create or replace function tc_test.fund(p_profile uuid, p_amount numeric)
returns void
language plpgsql
as $$
begin
  perform public.wallet_post(
    p_user_id    => p_profile,
    p_type       => 'ADMIN_ADJUSTMENT',
    p_amount     => p_amount,
    p_status     => 'COMPLETED',
    p_reference  => 'TESTFUND-' || gen_random_uuid()::text,
    p_description => 'Test funding',
    p_source     => 'TEST'
  );
end;
$$;

create or replace function tc_test.create_deposit(
  p_user   uuid,
  p_amount numeric,
  p_ref    text
)
returns uuid
language sql
as $$
  insert into public.deposits (user_id, wallet_id, amount, currency, phone, merchant_reference)
  values (p_user, (select id from public.wallets where user_id = p_user),
          p_amount, 'KES', '+254700000000', p_ref)
  returning id;
$$;

/** Campaign + active video. Returns the video id; campaign id via OUT. */
create or replace function tc_test.create_video(
  p_reward    numeric,
  p_budget    numeric,
  p_required  int default 1,
  p_daily_limit int default 10,
  out campaign_id uuid,
  out video_id uuid
)
language plpgsql
as $$
begin
  insert into public.video_campaigns (name, budget, spent, reward_per_view, status)
  values ('Test campaign ' || substr(gen_random_uuid()::text, 1, 8), p_budget, 0, p_reward, 'ACTIVE')
  returning id into campaign_id;

  insert into public.videos (
    campaign_id, title, video_url, duration_seconds, required_watch_seconds,
    reward_amount, currency, daily_limit, status
  ) values (
    campaign_id, 'Test video ' || substr(gen_random_uuid()::text, 1, 8), 'https://example.test/v.mp4',
    greatest(30, p_required), p_required, p_reward, 'KES', p_daily_limit, 'ACTIVE'
  )
  returning id into video_id;
end;
$$;

/**
 * Opens a watch session and rewinds its start time, so a "completed watch" can
 * be reached without sleeping. The server still does all of its own checks —
 * this only manipulates the clock, which is exactly what a slow test cannot do.
 */
create or replace function tc_test.begin_watch(
  p_user    uuid,
  p_video   uuid,
  p_elapsed int default 5
)
returns uuid
language plpgsql
as $$
declare
  v record;
begin
  select * into v from public.video_start(p_user, p_video, null, null);

  update public.video_watch_sessions
     set started_at      = now() - make_interval(secs => p_elapsed),
         watched_seconds = required_watch_seconds,
         status          = 'WATCHING'
   where session_token = v.session_token;

  return v.session_token;
end;
$$;

/** Creates a package. `p_cap` is the daily earning allowance (0 = unconfigured). */
create or replace function tc_test.create_package(
  p_price  numeric,
  p_cap    numeric,
  p_status text default 'ACTIVE',
  p_currency text default 'KES'
)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  insert into public.packages (name, price, currency, daily_earning_cap, status, sort_order)
  values ('Test package ' || substr(gen_random_uuid()::text, 1, 8), p_price, p_currency,
          p_cap, p_status, 100)
  returning id into v_id;
  return v_id;
end;
$$;

/**
 * Puts a video into a package, at a rate for that package.
 *
 * Since 0020 one video may belong to MANY packages and pay a different figure in
 * each, so `p_rate` is what the tier pays for it. NULL keeps the old behaviour of
 * falling back to the video's own `reward_amount`.
 */
create or replace function tc_test.attach_video(
  p_package uuid,
  p_video   uuid,
  p_rate    numeric default null
)
returns void
language sql
as $$
  insert into public.package_videos (package_id, video_id, reward_amount)
  values (p_package, p_video, p_rate);
$$;

/** Rewinds a rewarded session to a given number of days ago. */
create or replace function tc_test.backdate_reward(p_session_token uuid, p_days int)
returns void
language sql
as $$
  update public.video_watch_sessions
     set rewarded_at = rewarded_at - make_interval(days => p_days)
   where session_token = p_session_token;
$$;

create or replace function tc_test.request_withdrawal(
  p_user   uuid,
  p_amount numeric,
  p_key    text
)
returns public.withdrawals
language plpgsql
as $$
declare
  v public.withdrawals;
begin
  select * into v from public.withdrawal_reserve(p_user, p_amount, '+254700000000', p_key, null, 0);
  return v;
end;
$$;

/** Simulates the administrator approval step the API performs. */
create or replace function tc_test.approve(p_withdrawal uuid, p_admin uuid)
returns void
language sql
as $$
  update public.withdrawals
     set status = 'APPROVED', admin_id = p_admin, admin_approved_at = now()
   where id = p_withdrawal;
$$;

create or replace function tc_test.ledger_count(p_reference text)
returns int
language sql
as $$
  select count(*)::int from public.wallet_transactions where reference = p_reference;
$$;
