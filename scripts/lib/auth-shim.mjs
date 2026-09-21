/**
 * Supabase `auth` compatibility shim.
 *
 * These migrations depend on four things Supabase provides: the `auth.users`
 * table (profiles reference it), the `auth.uid()` function (RLS policies call
 * it), and the `anon` / `authenticated` / `service_role` roles (the grants and
 * policies are written against them).
 *
 * On a real Supabase project all four already exist, and this is a no-op. On a
 * bare Postgres — a CI service container, for example — it creates the minimum
 * needed so the migrations and the money tests can run against a real database
 * instead of an untested script.
 *
 * This is a test/dev convenience. It is NOT a Supabase replacement, and it is
 * never used by the application itself.
 */

const SHIM_SQL = `
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin noinherit', r);
    end if;
  end loop;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text unique,
  raw_user_meta_data  jsonb not null default '{}'::jsonb,
  email_confirmed_at  timestamptz,
  phone               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Mirrors the semantics the policies rely on: the caller's user id comes from
-- the JWT, never from anything the client can set directly.
create or replace function auth.uid()
returns uuid
language plpgsql
stable
as $fn$
declare
  v text;
begin
  v := current_setting('request.jwt.claim.sub', true);

  if v is null or v = '' then
    v := nullif(current_setting('request.jwt.claims', true), '');
    if v is not null then
      begin
        v := v::jsonb ->> 'sub';
      exception when others then
        v := null;
      end;
    end if;
  end if;

  if v is null or v = '' then
    return null;
  end if;

  begin
    return v::uuid;
  exception when others then
    return null;
  end;
end;
$fn$;
`;

export async function authShimPresent(client) {
  const { rows } = await client.query(
    `select 1
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'auth' and p.proname = 'uid'
      limit 1`,
  );
  return rows.length > 0;
}

/**
 * Install the shim if it is missing. Returns true when it was created, false
 * when a Supabase-provided (or already installed) `auth` schema was found.
 */
export async function ensureAuthShim(client, log = () => {}) {
  if (await authShimPresent(client)) {
    log("  · auth compatibility already present, skipping shim");
    return false;
  }
  await client.query(SHIM_SQL);
  log("  → auth compatibility shim installed (bare Postgres detected)");
  return true;
}
