-- ============================================================================
-- TaskCash Pro — 0006 Support tickets
--
-- Users need a way to reach a human about money: a payment that did not
-- arrive, a withdrawal that is taking too long, an account they cannot get
-- into. Email alone loses that history, so reports become tickets with a
-- reference the user can quote.
--
-- Same design rule as the financial tables: the browser gets SELECT on its own
-- rows and no INSERT/UPDATE policy at all. Tickets are created and replied to
-- through SECURITY DEFINER functions, so a client cannot set its own status,
-- priority, or assigned admin — and cannot open a ticket in another user's name.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------
create table if not exists public.support_tickets (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  reference          text not null unique,
  category           text not null default 'GENERAL',
  subject            text not null,
  status             text not null default 'OPEN',
  priority           text not null default 'NORMAL',
  related_reference  text,
  assigned_admin_id  uuid references public.profiles(id) on delete set null,
  last_activity_at   timestamptz not null default now(),
  resolved_at        timestamptz,
  closed_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint support_tickets_status_check
    check (status in ('OPEN', 'IN_REVIEW', 'RESOLVED', 'CLOSED')),
  constraint support_tickets_category_check
    check (category in ('GENERAL', 'PAYMENT', 'DEPOSIT', 'WITHDRAWAL', 'ACCOUNT', 'REWARDS', 'REFERRALS', 'OTHER')),
  constraint support_tickets_priority_check
    check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  constraint support_tickets_subject_len
    check (char_length(btrim(subject)) between 3 and 140),
  constraint support_tickets_reference_len
    check (char_length(reference) between 4 and 32)
);

create table if not exists public.support_messages (
  id           uuid primary key default gen_random_uuid(),
  ticket_id    uuid not null references public.support_tickets(id) on delete cascade,
  author_id    uuid references public.profiles(id) on delete set null,
  author_role  text not null default 'USER',
  body         text not null,
  created_at   timestamptz not null default now(),

  constraint support_messages_author_role_check
    check (author_role in ('USER', 'ADMIN', 'SYSTEM')),
  constraint support_messages_body_len
    check (char_length(btrim(body)) between 1 and 5000)
);

-- ---------------------------------------------------------------------------
-- indexes
-- ---------------------------------------------------------------------------
create index if not exists support_tickets_user_idx
  on public.support_tickets (user_id, created_at desc);
create index if not exists support_tickets_status_idx
  on public.support_tickets (status, last_activity_at desc);
create index if not exists support_messages_ticket_idx
  on public.support_messages (ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.support_tickets_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists support_tickets_touch_trigger on public.support_tickets;
create trigger support_tickets_touch_trigger
  before update on public.support_tickets
  for each row execute function public.support_tickets_touch();

-- ---------------------------------------------------------------------------
-- reference generator — short, unambiguous, quotable over the phone
-- ---------------------------------------------------------------------------
create or replace function public.support_reference()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; -- no I/L/O/0/1
  candidate text;
  i int;
begin
  loop
    candidate := 'TCS-';
    for i in 1..6 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.support_tickets where reference = candidate);
  end loop;
  return candidate;
end;
$$;

revoke all on function public.support_reference() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- create a ticket (the caller's own — identity comes from auth.uid(), not a
-- parameter, so one user cannot open a ticket for another)
-- ---------------------------------------------------------------------------
create or replace function public.support_create_ticket(
  p_category          text,
  p_subject           text,
  p_body              text,
  p_related_reference text default null
)
returns public.support_tickets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := public.current_profile_id();
  v_ticket  public.support_tickets;
begin
  if v_user_id is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  if p_category not in ('GENERAL', 'PAYMENT', 'DEPOSIT', 'WITHDRAWAL', 'ACCOUNT', 'REWARDS', 'REFERRALS', 'OTHER') then
    raise exception 'INVALID_CATEGORY' using errcode = '22023';
  end if;

  if char_length(btrim(coalesce(p_subject, ''))) < 3 then
    raise exception 'SUBJECT_REQUIRED' using errcode = '22023';
  end if;

  if char_length(btrim(coalesce(p_body, ''))) < 1 then
    raise exception 'MESSAGE_REQUIRED' using errcode = '22023';
  end if;

  insert into public.support_tickets (user_id, reference, category, subject, related_reference)
  values (
    v_user_id,
    public.support_reference(),
    p_category,
    btrim(p_subject),
    nullif(btrim(coalesce(p_related_reference, '')), '')
  )
  returning * into v_ticket;

  insert into public.support_messages (ticket_id, author_id, author_role, body)
  values (v_ticket.id, v_user_id, 'USER', btrim(p_body));

  return v_ticket;
end;
$$;

-- ---------------------------------------------------------------------------
-- add a message to the caller's own open ticket
-- ---------------------------------------------------------------------------
create or replace function public.support_add_message(
  p_ticket_id uuid,
  p_body      text
)
returns public.support_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := public.current_profile_id();
  v_ticket  public.support_tickets;
  v_message public.support_messages;
begin
  if v_user_id is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  select * into v_ticket
    from public.support_tickets
   where id = p_ticket_id and user_id = v_user_id
   for update;

  if not found then
    raise exception 'TICKET_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_ticket.status = 'CLOSED' then
    raise exception 'TICKET_CLOSED' using errcode = '22023';
  end if;

  if char_length(btrim(coalesce(p_body, ''))) < 1 then
    raise exception 'MESSAGE_REQUIRED' using errcode = '22023';
  end if;

  insert into public.support_messages (ticket_id, author_id, author_role, body)
  values (v_ticket.id, v_user_id, 'USER', btrim(p_body))
  returning * into v_message;

  -- A new reply reopens a resolved ticket, because the user clearly still needs
  -- help. A closed ticket is final.
  update public.support_tickets
     set status           = case when status = 'RESOLVED' then 'OPEN' else status end,
         resolved_at      = case when status = 'RESOLVED' then null else resolved_at end,
         last_activity_at = now()
   where id = v_ticket.id;

  return v_message;
end;
$$;

revoke all on function public.support_create_ticket(text, text, text, text) from public, anon;
revoke all on function public.support_add_message(uuid, text) from public, anon;
grant execute on function public.support_create_ticket(text, text, text, text) to authenticated;
grant execute on function public.support_add_message(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- row level security — read your own, write nothing directly
-- ---------------------------------------------------------------------------
alter table public.support_tickets  enable row level security;
alter table public.support_messages enable row level security;

drop policy if exists support_tickets_select_own on public.support_tickets;
create policy support_tickets_select_own on public.support_tickets
  for select
  using (user_id = public.current_profile_id());

drop policy if exists support_messages_select_own on public.support_messages;
create policy support_messages_select_own on public.support_messages
  for select
  using (
    exists (
      select 1 from public.support_tickets t
       where t.id = support_messages.ticket_id
         and t.user_id = public.current_profile_id()
    )
  );
