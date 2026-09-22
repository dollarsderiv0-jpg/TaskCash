#!/usr/bin/env node
/**
 * Egress diagnostic for the PayHero collection path.
 *
 * PayHero answered `POST /api/v2/payments` with HTTP 417
 * `rate limit exceeded: request throttled` from Vercel's runtime while the same
 * credentials were accepted from a developer machine seconds later. An
 * account-level limit cannot produce that, so the limit is keyed to the SOURCE
 * IP — which makes the egress address part of the payment configuration.
 *
 * This script answers the only two questions that matter before changing
 * production infrastructure:
 *
 *   1. Which outbound address does the outside world see from HERE?
 *   2. Does PayHero accept our credentials from that address?
 *
 * It is deliberately read-only: `GET /transactions` lists account transactions
 * and creates nothing. No payment, no STK push, no deposit row, no ledger entry.
 *
 * It prints no credential — only variable NAMES, a host, and HTTP status.
 *
 *   node scripts/check-egress.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

function loadEnvLocal() {
  const out = {};
  const file = resolve(".env.local");
  if (!existsSync(file)) return out;

  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function env(name) {
  return (process.env[name] ?? globalThis.__envLocal?.[name] ?? "").trim();
}

globalThis.__envLocal = loadEnvLocal();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A proxy URL commonly carries a password, so only the host is ever shown. A
 * diagnostic that leaks the credential it was run to protect is worse than no
 * diagnostic.
 */
function describeProxy(raw) {
  if (!raw) return "(not set)";
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "(set, unparseable)";
  }
}

async function outboundIp() {
  // Two independent echo services: one IP echo failing must not read as
  // "no egress at all".
  const sources = [
    ["https://api.ipify.org?format=json", (b) => b.ip],
    ["https://ifconfig.me/all.json", (b) => b.ip_addr],
  ];

  for (const [url, pick] of sources) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) continue;
      const body = await response.json();
      const ip = pick(body);
      if (ip) return { ip, source: new URL(url).hostname };
    } catch {
      /* try the next source */
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

console.log("\nEgress as the outside world sees it\n");

const configuredProxy = env("HTTPS_PROXY") || env("https_proxy") || env("HTTP_PROXY") || env("http_proxy");
const proxyInUse = env("NODE_USE_ENV_PROXY") === "1";

console.log(`  HTTPS_PROXY / HTTP_PROXY      ${describeProxy(configuredProxy)}`);
console.log(`  NODE_USE_ENV_PROXY            ${env("NODE_USE_ENV_PROXY") || "(not set)"}`);
console.log(
  `  → proxy actually applied      ${
    proxyInUse && configuredProxy ? "yes (Node ≥24 honours the env vars)" : "no — direct egress"
  }`,
);

const egress = await outboundIp();
if (!egress) {
  console.log("\n  ✗ could not determine the outbound address (no echo service reachable)");
} else {
  console.log(`  outbound address              ${egress.ip}   (via ${egress.source})`);
}

/* --- PayHero reachability: read-only, never a payment -------------------- */

console.log("\nPayHero credentials + reachability (read-only: GET /transactions)\n");

const baseUrl = (env("PAYHERO_API_URL") || "https://backend.payhero.co.ke/api/v2").replace(/\/+$/, "");
const username = env("PAYHERO_API_USERNAME");
const password = env("PAYHERO_API_PASSWORD");

console.log(`  endpoint                      ${baseUrl}`);
console.log(`  PAYHERO_API_USERNAME          ${username ? "set" : "MISSING"}`);
console.log(`  PAYHERO_API_PASSWORD          ${password ? "set" : "MISSING"}`);
console.log(`  PAYHERO_CHANNEL_ID            ${env("PAYHERO_CHANNEL_ID") ? "set" : "MISSING"}`);

let probeFailed = false;

if (!username || !password) {
  console.log("\n  ✗ credentials missing — nothing to probe");
  probeFailed = true;
} else {
  try {
    const response = await fetch(`${baseUrl}/transactions?page=1&per_page=1`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20000),
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    const rows = Array.isArray(payload) ? payload : payload?.data ?? payload?.transactions;
    const count = Array.isArray(rows) ? rows.length : null;
    const message =
      payload?.error_message ?? payload?.message ?? payload?.detail ?? payload?.error ?? null;

    console.log(`  HTTP status                   ${response.status}`);
    if (message) console.log(`  provider message              ${message}`);
    console.log(`  transactions visible          ${count === null ? "(envelope not recognised)" : count}`);

    if (response.status === 417 || /rate limit|throttl/i.test(String(message ?? ""))) {
      console.log("\n  ⚠ THROTTLED from this address — the collection endpoint is rate-limited\n" +
        "    per source IP, which is the production blocker.");
      probeFailed = true;
    } else if (response.ok) {
      console.log("\n  ✓ credentials authenticated and the endpoint is reachable from this address,");
      console.log("    and no payment was created by this probe.");
    } else {
      console.log(`\n  ✗ unexpected refusal (HTTP ${response.status})`);
      probeFailed = true;
    }
  } catch (error) {
    console.log(`  ✗ request failed: ${error?.name === "TimeoutError" ? "timed out" : error?.message}`);
    probeFailed = true;
  }
}

console.log("\nNo payment, STK push, deposit row or ledger entry was created.\n");
process.exit(probeFailed ? 1 : 0);
