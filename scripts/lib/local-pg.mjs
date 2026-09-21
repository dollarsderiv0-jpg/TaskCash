/**
 * A real Postgres for local test runs, without Docker, a server install, or
 * any credentials.
 *
 * PGlite is Postgres 17 compiled to WebAssembly. `@electric-sql/pglite-socket`
 * exposes it over the Postgres wire protocol on a loopback port, so the suite
 * connects with the ordinary `pg` client and nothing about the tests changes —
 * the migrations and the assertions run against a genuine Postgres engine.
 *
 * Think of this as "any Postgres" for developer machines and CI. It is NOT
 * Supabase: there is no `auth` schema (the suite installs its own shim), no
 * PostgREST, and — because PGlite serialises queries across connections — the
 * true two-connection race cannot run here. CI against a real server (or a
 * Supabase branch) still runs that part.
 */

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

/**
 * The one thing PGlite does not ship that the migrations assume.
 *
 * `0001_schema.sql` does `create extension if not exists pgcrypto`. PGlite
 * bundles a fixed set of contrib modules and pgcrypto is not among them. Every
 * function the schema actually uses from it — `gen_random_uuid()` — has been
 * part of Postgres core since 13, so a no-op stub is faithful here; this is
 * recorded loudly rather than hidden, because it means local runs do not
 * exercise pgcrypto itself.
 */
const PGCRYPTO_STUB = `
create schema if not exists pgcrypto_shim;
`;

export async function startLocalPostgres({ log = () => {} } = {}) {
  const db = await PGlite.create();

  const hasPgcrypto = await supportsExtension(db, "pgcrypto");
  if (!hasPgcrypto) {
    await db.exec(PGCRYPTO_STUB);
    log("  · local Postgres: pgcrypto is not bundled by PGlite (gen_random_uuid is core ≥13)");
  }

  const server = new PGLiteSocketServer({
    db,
    port: 0,
    host: "127.0.0.1",
    maxConnections: 8,
  });
  await server.start();

  // getServerConn() yields "host:port" with no scheme, and PGlite owns exactly
  // one database, so the URL is assembled rather than derived from input.
  const host = server.getServerConn();
  const url = `postgresql://postgres@${host}/postgres`;
  log(`  · local Postgres listening on ${host}`);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await server.stop().catch(() => {});
    await db.close().catch(() => {});
  };

  return { db, server, url, stop, hasPgcrypto };
}

/**
 * `create extension` is the only way to know, and it fails by throwing — so
 * probe in a rolled-back transaction rather than trusting a version table.
 */
async function supportsExtension(db, name) {
  try {
    await db.exec("begin");
    await db.exec(`create extension if not exists "${name}"`);
    await db.exec("rollback");
    return true;
  } catch {
    await db.exec("rollback").catch(() => {});
    return false;
  }
}

/**
 * Migrations are authored for Supabase, which always has pgcrypto. Locally we
 * translate the one statement that cannot work into something equivalent, so
 * the file being tested is otherwise byte-for-byte the file that ships.
 */
export function bridgeUnsupportedExtensions(sql) {
  return sql.replace(
    /create\s+extension\s+if\s+not\s+exists\s+"?pgcrypto"?\s*;/gi,
    "-- pgcrypto is unavailable under PGlite; gen_random_uuid() is core since Postgres 13",
  );
}
