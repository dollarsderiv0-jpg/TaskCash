-- ============================================================================
-- 0011 — public.video_progress() could never run (42702)
--
-- THE BUG
--
-- The function declares its result columns as OUT parameters, one of which is
-- named `watched_seconds` — and then referenced `watched_seconds` unqualified
-- inside its own UPDATE:
--
--     update public.video_watch_sessions
--        set watched_seconds = greatest(watched_seconds, least(v_claimed, v_elapsed + 1.5)),
--                                       ^^^^^^^^^^^^^^^ ambiguous
--
-- PL/pgSQL exposes OUT parameters as variables, so Postgres cannot tell the
-- parameter from the table column and raises:
--
--     42702  column reference "watched_seconds" is ambiguous
--
-- on EVERY call. The function has therefore never worked. Measured, not
-- inferred: `select * from public.video_progress(...)` on a local Postgres
-- raises exactly that, while public.video_start() next to it runs fine.
--
-- WHY IT WENT UNNOTICED
--
-- Two reasons, and both are the reason this file says so much:
--
--   1. plpgsql bodies are parsed when EXECUTED, so the function created and
--      validated cleanly. Applying the migration proves nothing about it.
--   2. Nothing called it. The browser's progress effect was itself dead (the
--      interval was re-created every second because `elapsed` was in the
--      dependency array), so this 500 was never reached.
--
-- Fixing the client exposed it immediately: the first real call since the
-- function was written returned HTTP 500 with this ambiguity.
--
-- THE FIX
--
-- Alias the target table and qualify the column. Qualifying is preferred over
-- renaming the OUT parameter: the caller reads these column names
-- (`watched_seconds`, `required_watch_seconds`, `elapsed_seconds`, `status`,
-- `ready`), so renaming would break the API mapping.
--
-- Behaviour is otherwise unchanged, including the clamp that refuses to believe
-- a claim larger than the wall-clock time the server has observed
-- (`least(claimed, elapsed + 1.5)`) and the SESSION_CLOSED guard.
--
-- Nothing here writes a balance or creates a reward.
-- ============================================================================

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

  -- The alias is the fix: `s.watched_seconds` can only be the column, never the
  -- OUT parameter of the same name.
  update public.video_watch_sessions as s
     set watched_seconds = greatest(s.watched_seconds, least(v_claimed, v_elapsed + 1.5)),
         last_activity_at = now(),
         status = 'WATCHING'
   where s.id = v_session.id
   returning * into v_session;

  return query
    select v_session.watched_seconds, v_session.required_watch_seconds, v_elapsed,
           v_session.status,
           (v_session.watched_seconds >= v_session.required_watch_seconds and v_elapsed >= v_session.required_watch_seconds);
end;
$$;

-- CREATE OR REPLACE preserves the ACL; re-asserted so a future drop/recreate
-- cannot quietly leave this callable from a user session.
revoke all on function public.video_progress(uuid, uuid, numeric) from public, anon, authenticated;
grant execute on function public.video_progress(uuid, uuid, numeric) to service_role;
