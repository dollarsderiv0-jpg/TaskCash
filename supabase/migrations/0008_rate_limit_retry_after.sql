-- ---------------------------------------------------------------------------
-- 0008: rate limiting that can state its own retry time
--
-- public.rate_limit_hit() answers one question: allowed, or not? That is the
-- right answer for a log line but a terrible one for a person. A refusal in a
-- fixed window can be refused for up to a full window (an hour for
-- registration), and "try again shortly" invites the user to retry immediately
-- -- which increments the counter again and can never succeed.
--
-- This adds a companion that answers "allowed, or not, and if not, when?".
-- The arithmetic lives here, next to the window it describes, so the two can
-- never drift apart: the reset instant is the window the counter was written
-- to, plus one window.
--
-- rate_limit_hit() is left exactly as it was. It is used by the remote schema
-- check and by any deployment mid-upgrade, and changing its return type would
-- break both.
-- ---------------------------------------------------------------------------

create or replace function public.rate_limit_hit_info(
  p_bucket         text,
  p_identifier     text,
  p_limit          int,
  p_window_seconds int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window   timestamptz;
  v_reset_at timestamptz;
  v_hits     int;
  v_allowed  boolean;
  v_retry    int;
begin
  -- A limit of zero or less means the bucket is switched off, and the reset
  -- instant is meaningless. Report it as always-available rather than as a
  -- block with a zero-second wait, which a client would render as a countdown
  -- to nowhere.
  if p_limit <= 0 or p_window_seconds <= 0 then
    return jsonb_build_object(
      'allowed', true,
      'hits', 0,
      'limit', greatest(p_limit, 0),
      'retry_after_seconds', 0,
      'reset_at', null
    );
  end if;

  -- Fixed (tumbling) window aligned to the epoch, as in rate_limit_hit().
  v_window   := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_reset_at := v_window + make_interval(secs => p_window_seconds);

  -- A refused attempt still counts. Otherwise a caller at the limit could
  -- hammer the endpoint indefinitely at no cost, and the counter would
  -- under-report exactly the traffic worth recording.
  insert into public.rate_limits (bucket, identifier, window_start, hits)
  values (p_bucket, p_identifier, v_window, 1)
  on conflict (bucket, identifier, window_start)
    do update set hits = public.rate_limits.hits + 1
  returning hits into v_hits;

  v_allowed := v_hits <= p_limit;

  -- Ceil so a caller never retries a fraction of a second too early and is
  -- refused with a fresh, identical message. Least 1: a refusal always implies
  -- at least some wait.
  v_retry := greatest(1, ceil(extract(epoch from (v_reset_at - now())))::int);

  return jsonb_build_object(
    'allowed', v_allowed,
    'hits', v_hits,
    'limit', p_limit,
    'retry_after_seconds', case when v_allowed then 0 else v_retry end,
    'reset_at', case when v_allowed then null else v_reset_at end
  );
end;
$$;

comment on function public.rate_limit_hit_info(text, text, int, int) is
  'Atomically counts a hit and reports whether it is allowed plus, when refused, the exact seconds until the window resets.';

-- Same privilege posture as every other infrastructure function: callable by
-- the server only. A client could otherwise read its own remaining budget, or
-- exhaust another identifier's budget by calling it directly.
revoke all on function public.rate_limit_hit_info(text, text, int, int)
  from public, anon, authenticated;
grant execute on function public.rate_limit_hit_info(text, text, int, int)
  to service_role;

-- ---------------------------------------------------------------------------
-- Retention
--
-- Counters are worthless once their window has passed, but they accumulate one
-- row per bucket per identifier per window forever, which is unbounded. This
-- prunes only rows that can no longer influence a decision -- strictly older
-- than the widest window the application configures (one hour), with a day of
-- margin so a clock skew or a long outage cannot delete a live counter.
-- ---------------------------------------------------------------------------
create or replace function public.rate_limit_prune(p_older_than_seconds int default 86400)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  if p_older_than_seconds is null or p_older_than_seconds < 3600 then
    -- Refuse to prune anything a live window might still be counting on.
    p_older_than_seconds := 86400;
  end if;

  delete from public.rate_limits
   where window_start < now() - make_interval(secs => p_older_than_seconds);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.rate_limit_prune(int) from public, anon, authenticated;
grant execute on function public.rate_limit_prune(int) to service_role;
