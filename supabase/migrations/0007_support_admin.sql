-- ============================================================================
-- TaskCash Pro — 0007 Support (administrator side)
--
-- 0006 created the tickets and let a user open and reply to their own. That is
-- only half the feature: with no administrator path, IN_REVIEW, RESOLVED and
-- CLOSED were statuses nothing could ever reach.
--
-- This adds the single write path an administrator needs — reply and/or move the
-- status — as a SECURITY DEFINER function that (a) refuses anyone who is not an
-- active administrator, (b) writes an audit record, and (c) notifies the user in
-- the same transaction, so a reply cannot exist without the user being told.
-- ============================================================================

create or replace function public.support_admin_reply(
  p_ticket_id uuid,
  p_body      text default null,
  p_status    text default null,
  p_ip_hash   text default null
)
returns public.support_tickets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id uuid := public.current_profile_id();
  v_ticket   public.support_tickets;
begin
  -- Authorization is decided here, from the caller's own profile, never from a
  -- parameter. is_admin() is not granted to authenticated clients for policy
  -- use, but a SECURITY DEFINER function may call it.
  if v_admin_id is null or not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_ticket
    from public.support_tickets
   where id = p_ticket_id
   for update;

  if not found then
    raise exception 'TICKET_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_status is not null and p_status not in ('OPEN', 'IN_REVIEW', 'RESOLVED', 'CLOSED') then
    raise exception 'INVALID_STATUS' using errcode = '22023';
  end if;

  -- A reply is optional: an administrator may simply move the status.
  if p_body is not null and char_length(btrim(p_body)) > 0 then
    insert into public.support_messages (ticket_id, author_id, author_role, body)
    values (v_ticket.id, v_admin_id, 'ADMIN', btrim(p_body));
  end if;

  update public.support_tickets
     set status = coalesce(p_status, status),
         -- Kept consistent with the status it belongs to, so a report can trust
         -- these columns rather than re-deriving them from history.
         resolved_at = case
                         when p_status = 'RESOLVED' then now()
                         when p_status = 'CLOSED' then resolved_at
                         when p_status in ('OPEN', 'IN_REVIEW') then null
                         else resolved_at
                       end,
         closed_at = case
                       when p_status = 'CLOSED' then now()
                       when p_status in ('OPEN', 'IN_REVIEW', 'RESOLVED') then null
                       else closed_at
                     end,
         assigned_admin_id = coalesce(assigned_admin_id, v_admin_id),
         last_activity_at = now()
   where id = v_ticket.id
  returning * into v_ticket;

  perform public.write_audit(
    v_admin_id,
    v_ticket.user_id,
    'SUPPORT_REPLY',
    'support_ticket',
    v_ticket.id::text,
    'Administrator replied to support request ' || v_ticket.reference ||
      case when p_status is not null then ' (status ' || p_status || ')' else '' end,
    jsonb_build_object('reference', v_ticket.reference, 'status', v_ticket.status),
    p_ip_hash,
    null
  );

  -- The user learns a reply exists at the moment it is written. Done with
  -- notify_user so the wording lives in one place, and only when there is
  -- something new to tell them.
  if p_body is not null and char_length(btrim(p_body)) > 0 then
    perform public.notify_user(
      v_ticket.user_id,
      'SUPPORT_REPLY',
      'Support replied to your request',
      'We have answered support request ' || v_ticket.reference || '. Open it to read our reply.',
      'INFO',
      '/support',
      jsonb_build_object('ticketId', v_ticket.id, 'reference', v_ticket.reference)
    );
  end if;

  return v_ticket;
end;
$$;

revoke all on function public.support_admin_reply(uuid, text, text, text) from public, anon;
grant execute on function public.support_admin_reply(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The user must be able to READ an administrator reply on their own ticket.
-- 0006 already grants that (messages are readable when the parent ticket belongs
-- to the caller), and an ADMIN-authored row is no different — no new policy is
-- needed. This comment exists so nobody "fixes" that later by assuming a
-- separate admin-authored read policy is missing.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- No new index: 0006 already created `support_tickets_status_idx` on
-- (status, last_activity_at desc), which is exactly the administrator queue's
-- access pattern. A second identical index would only cost writes.
-- ---------------------------------------------------------------------------
