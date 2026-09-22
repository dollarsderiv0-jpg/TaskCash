#!/usr/bin/env node
/**
 * Seed demo accounts, each with a deposit and a withdrawal.
 *
 *   npm run seed:users                                  # DRY RUN — writes nothing
 *   npm run seed:users -- --count=400 --apply            # create the batch
 *   npm run seed:users -- --batch=demo-a --count=25 --apply
 *   npm run seed:users -- --rollback=demo-a              # report what a rollback would remove
 *   npm run seed:users -- --rollback=demo-a --apply      # and remove it
 *
 * WHY THIS IS BUILT THIS WAY
 * --------------------------
 * These are FABRICATED financial records. Nobody deposited anything and nobody
 * was paid. So every row this script writes carries the batch id, and the batch
 * id is the thing that makes the whole run removable in one pass:
 *
 *   · auth users     — `seed.<n>.<batch>@taskcash-seed.invalid`. The `.invalid`
 *                      TLD is reserved by RFC 2606, so no seeded address can
 *                      ever reach a real inbox, and the domain alone marks it.
 *   · profiles       — `metadata.seedBatch` = the batch id
 *   · deposits       — merchant reference `SEED-<batch>-<n>`, plus
 *                      `callback_payload.seeded = true`
 *   · withdrawals    — idempotency key `seed:<batch>:<n>`
 *   · ledger rows    — reachable from the deposit they came from, which carries
 *                      the batch: `deposit_credit` writes `DEP-<deposit id>` as
 *                      the row's reference. The rows themselves are NOT marked
 *                      with `source = 'SEED'`, because the ledger's source is set
 *                      inside `deposit_credit` and this script does not write
 *                      ledger rows — see the note at the bottom of this header.
 *
 * ONE WART THIS LEAVES, DELIBERATELY
 * ----------------------------------
 * `deposit_credit` passes a hardcoded `p_source => 'MPESA'` to `wallet_post`
 * (0015, reproduced in 0022). So the ledger says MPESA for a deposit whose
 * `provider` is PAYHERO, and a seeded deposit looks the same as a real one by
 * `source` alone. That is a genuine inaccuracy in a money record, it predates
 * this script, and it is the reason the ledger cannot carry the batch marker
 * itself. Fixing it belongs in `deposit_credit`, not here.
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 * It does not insert ledger rows directly. `deposit_credit`, `withdrawal_reserve`,
 * `withdrawal_complete` and `withdrawal_release` are the same functions the
 * PayHero callback and the admin approval screen call, and they are the only
 * thing that moves a balance. A seeded account therefore has a wallet whose
 * `available_balance` agrees with the sum of its own ledger rows, the same
 * invariant a real account holds — a fabricated balance written straight into
 * `wallets` would have broken that, and the dashboard would have shown a total
 * that no transaction explains.
 *
 * Amounts are read from the currency's own limits, never hardcoded, and every
 * withdrawal is sized against `user_withdrawal_max` — so the run cannot invent a
 * withdrawal the platform itself would have refused.
 */

import { loadEnvLocal } from "./lib/migrate.mjs";

loadEnvLocal();

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");

const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const COUNT = Number(flag("count", "400"));
const CONCURRENCY = Number(flag("concurrency", "6"));
const ROLLBACK = flag("rollback", "");
/* Overridable so this can be pointed at a local database instead. */
const URL_BASE = flag("url", process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/*
  Readable at a glance in an admin list, and the suffix means two runs on the
  same day cannot collide.
*/
const BATCH = flag("batch", `demo-${new Date().toISOString().slice(0, 10)}`);

if (!URL_BASE || !KEY) {
  console.error("\n  ✗ NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required (put them in .env.local)\n");
  process.exit(2);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function rest(path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, { headers: H, ...init });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function rpc(name, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: H,
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rpc ${name} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function createAuthUser(email, fullName) {
  const res = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      email,
      // Random and never recorded anywhere: these accounts are not for signing
      // in, and a shared or printed password would be a real credential.
      password: `Seed-${crypto.randomUUID()}-Aa1`,
      email_confirm: true,
      user_metadata: { full_name: fullName, seedBatch: BATCH, seeded: true },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 422 || /already/i.test(text)) return { existing: true };
    throw new Error(`create user ${email} -> ${res.status} ${text.slice(0, 160)}`);
  }
  return { user: JSON.parse(text) };
}

/* -------------------------------------------------------------------------- */
/* names and amounts                                                          */
/* -------------------------------------------------------------------------- */

const FIRST = ["Brian","Faith","Kevin","Mercy","Dennis","Cynthia","Victor","Grace","Collins","Sharon","Felix","Winnie","Samuel","Njeri","Peter","Aisha","Moses","Diana","Elvis","Beatrice","Ian","Purity","Alvin","Zawadi","Collins","Nelly","Duncan","Esther","Eric","Lydia"];
const LAST = ["Otieno","Wanjiru","Mwangi","Achieng","Kiptoo","Nyambura","Ochieng","Chebet","Mutiso","Anyango","Barasa","Kilonzo","Wekesa","Njoroge","Odhiambo","Kamau","Wafula","Mueni","Kimani","Adhiambo"];

const pick = (list, n) => list[n % list.length];

const round50 = (n) => Math.max(50, Math.round(n / 50) * 50);

/*
  The plan is DETERMINISTIC — derived from the batch id and the index, never
  from Math.random().

  This is not tidiness. `deposit_credit` refuses a credit whose amount disagrees
  with the deposit row it is crediting (DEPOSIT_AMOUNT_MISMATCH), and it should:
  that check is what stops a provider confirming KES 10 from crediting KES 900.
  A plan that redraws its amounts every run therefore cannot be resumed — the
  second run asks to credit numbers the first run never wrote, and every account
  in the batch fails. Keying the amounts to the batch makes a re-run rebuild the
  identical plan, which is what makes the retry above safe.
*/
function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRand(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rand, min, max) => min + rand() * Math.max(0, max - min);

/* -------------------------------------------------------------------------- */
/* rollback                                                                   */
/* -------------------------------------------------------------------------- */

if (ROLLBACK) {
  console.log(`\n  TaskCash Pro — roll back seed batch "${ROLLBACK}"\n`);

  const profiles = await rest(
    `profiles?select=id,auth_user_id,email&metadata->>seedBatch=eq.${encodeURIComponent(ROLLBACK)}`,
  );
  const ids = profiles.map((p) => p.id);
  if (ids.length === 0) {
    console.log("  · no profiles carry that batch id — nothing to do\n");
    process.exit(0);
  }

  const list = ids.join(",");
  const counts = {};
  for (const [label, path] of [
    ["wallet_transactions", `wallet_transactions?select=id&user_id=in.(${list})`],
    ["withdrawals", `withdrawals?select=id&user_id=in.(${list})`],
    ["deposits", `deposits?select=id&user_id=in.(${list})`],
    ["user_packages", `user_packages?select=id&user_id=in.(${list})`],
    ["referrals", `referrals?select=id&referrer_id=in.(${list})`],
    ["wallets", `wallets?select=id&user_id=in.(${list})`],
  ]) {
    try {
      counts[label] = (await rest(path)).length;
    } catch {
      counts[label] = 0;
    }
  }

  console.log(`  profiles / auth users : ${ids.length}`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(22)}: ${v}`);

  if (!APPLY) {
    console.log("\n  · report only — re-run with --rollback=" + ROLLBACK + " --apply to remove it\n");
    process.exit(0);
  }

  /* Ledger first, then the rows it references, then the accounts. */
  for (const group of chunks(ids)) {
    const l = group.join(",");
    await rest(`wallet_transactions?user_id=in.(${l})`, { method: "DELETE" });
    await rest(`withdrawals?user_id=in.(${l})`, { method: "DELETE" });
    await rest(`deposits?user_id=in.(${l})`, { method: "DELETE" });
    await rest(`user_packages?user_id=in.(${l})`, { method: "DELETE" });
    await rest(`referrals?referrer_id=in.(${l})`, { method: "DELETE" });
    await rest(`wallets?user_id=in.(${l})`, { method: "DELETE" });
    await rest(`profiles?id=in.(${l})`, { method: "DELETE" });
  }

  let removed = 0;
  for (const p of profiles) {
    const res = await fetch(`${URL_BASE}/auth/v1/admin/users/${p.auth_user_id}`, { method: "DELETE", headers: H });
    if (res.ok) removed += 1;
  }

  console.log(`\n  ✓ removed ${ids.length} profile(s) and ${removed} auth user(s)\n`);
  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* the plan                                                                   */
/* -------------------------------------------------------------------------- */

const currency = (await rest("currencies?select=*&code=eq.KES"))[0];
if (!currency) {
  console.error("\n  ✗ no KES row in currencies — cannot size deposits against the platform's own limits\n");
  process.exit(2);
}

const currencyRows = await rest("currencies?select=code,enabled");

/* The reviewer recorded on an approved withdrawal — the platform's own admin. */
const adminProfile = (await rest("profiles?select=id&role=in.(ADMIN,SUPER_ADMIN)&limit=1"))[0] ?? null;
const otherEnabled = currencyRows.filter((c) => c.enabled && c.code !== currency.code).map((c) => c.code);

const minDeposit = Number(currency.min_deposit);
const maxDeposit = Number(currency.max_deposit ?? currency.min_deposit * 20);
const minWithdrawal = Number(currency.min_withdrawal);

/*
  A plausible spread: most people deposit the entry amount, a few go higher,
  and nobody deposits a round institutional number.
*/
function planUser(index) {
  const rand = makeRand(hashString(BATCH) + index * 2654435761);
  const deposit = round50(between(rand, minDeposit, Math.min(maxDeposit, minDeposit * 8)));
  /*
    Kept to half the deposit: a seeded account that deposits and immediately
    withdraws the lot is not a scenario the platform wants to look like it
    permits, and `withdrawal_reserve` would refuse the ones above the balance
    anyway.
  */
  const withdrawal = round50(
    between(rand, minWithdrawal, Math.min(minWithdrawal * 10, deposit / 2)),
  );

  const roll = Math.floor(rand() * 20);
  const outcome = roll < 3 ? "PENDING" : roll < 6 ? "REJECTED" : "COMPLETED";

  return {
    index,
    email: `seed.${String(index).padStart(4, "0")}.${BATCH}@taskcash-seed.invalid`,
    fullName: `${pick(FIRST, index * 7)} ${pick(LAST, index * 3)}`,
    phone: `2547${String(10000000 + ((index * 7919) % 89999999)).slice(0, 8)}`,
    deposit,
    withdrawal,
    outcome,
  };
}

const plan = Array.from({ length: COUNT }, (_, i) => planUser(i));

const totals = plan.reduce(
  (acc, u) => {
    acc.deposit += u.deposit;
    acc.withdrawal += u.withdrawal;
    acc[u.outcome] += 1;
    return acc;
  },
  { deposit: 0, withdrawal: 0, COMPLETED: 0, PENDING: 0, REJECTED: 0 },
);

console.log(`\n  TaskCash Pro — seed demo accounts\n`);
console.log(`  target          : ${URL_BASE}`);
console.log(`  batch           : ${BATCH}`);
console.log(`  accounts        : ${COUNT}`);
console.log(`  currency        : ${currency.code} (min deposit ${minDeposit}, max ${maxDeposit}, min withdrawal ${minWithdrawal}, fee ${currency.withdrawal_fee})`);
if (otherEnabled.length > 0) {
  console.log(`  ⚠ other enabled currencies left untouched: ${otherEnabled.join(", ")} — this seeds ${currency.code} only`);
}
console.log(`\n  deposits        : ${COUNT} totalling ${totals.deposit.toLocaleString()} ${currency.code}`);
console.log(`  withdrawals     : ${COUNT} totalling ${totals.withdrawal.toLocaleString()} ${currency.code}`);
console.log(`      paid        : ${totals.COMPLETED}`);
console.log(`      pending     : ${totals.PENDING}   (awaiting an administrator)`);
console.log(`      rejected    : ${totals.REJECTED}`);

console.log(`\n  first three:`);
for (const u of plan.slice(0, 3)) {
  console.log(`    ${u.email.padEnd(46)} ${u.fullName.padEnd(20)} dep ${String(u.deposit).padStart(6)}  wd ${String(u.withdrawal).padStart(5)}  ${u.outcome}`);
}

console.log(`\n  everything written carries batch "${BATCH}" — remove it with:`);
console.log(`    npm run seed:users -- --rollback=${BATCH} --apply\n`);

if (!APPLY) {
  console.log("  · DRY RUN — nothing was written. Re-run the same command with --apply to create it.\n");
  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* apply                                                                      */
/* -------------------------------------------------------------------------- */

const before = {
  profiles: (await rest("profiles?select=id")).length,
  deposits: (await rest("deposits?select=id")).length,
  withdrawals: (await rest("withdrawals?select=id")).length,
  wallet_transactions: (await rest("wallet_transactions?select=id")).length,
};

const failures = [];
let created = 0;
let resumed = 0;

/*
  Resumable on purpose.

  A run that dies — an ambiguous function, a rate limit, a closed laptop — must
  be safe to repeat, because the alternative is 400 accounts that exist and a
  batch that has to be picked apart by hand. So each account is found by its own
  address first, and every later step is checked for before it is performed:

    · account   — an existing profile for the address is reused, not recreated
    · deposit   — credited only if the credit is not already on the ledger
                  (`deposit_credit` is itself idempotent, and says so)
    · withdrawal — skipped if its idempotency key is present, because
                  `withdrawal_reserve` raises on a repeat key by design
*/
async function seedOne(u) {
  let profile = (await rest(`profiles?select=id&auth_user_id&email=eq.${encodeURIComponent(u.email)}`))[0];

  if (profile) {
    resumed += 1;
  } else {
    const auth = await createAuthUser(u.email, u.fullName);
    if (!auth.user?.id) {
      failures.push(`${u.email}: could not create the account (${auth.existing ? "already existed" : "no id returned"})`);
      return;
    }

    await rpc("ensure_profile", {
      p_auth_user_id: auth.user.id,
      p_email: u.email,
      p_metadata: { full_name: u.fullName, seedBatch: BATCH, seeded: true, country: "KE", currency: currency.code },
    });

    profile = (await rest(`profiles?select=id&auth_user_id=eq.${auth.user.id}`))[0];
    if (!profile) throw new Error("profile was not provisioned");

    /* The batch marker, written after provisioning so it cannot be overwritten. */
    await rest(`profiles?id=eq.${profile.id}`, {
      method: "PATCH",
      body: JSON.stringify({ metadata: { seedBatch: BATCH, seeded: true }, phone: u.phone, country: "KE" }),
    });
  }

  const wallet = (await rest(`wallets?select=id&user_id=eq.${profile.id}`))[0];
  if (!wallet) throw new Error("wallet was not provisioned");

  /*
    The deposit row first, then the credit by merchant reference — the same order
    the PayHero callback uses. `deposit_credit` is what posts the ledger row and
    sets COMPLETED, so the balance can never leave the transactions behind.
  */
  const merchantReference = `SEED-${BATCH}-${u.index}`;
  const existingDeposit = (
    await rest(
      `deposits?select=id,status,amount&merchant_reference=eq.${encodeURIComponent(merchantReference)}`,
    )
  )[0];

  /*
    On a resume the stored row is the authority on the amount, because that is
    the figure `deposit_credit` checks the credit against. The plan's number is
    only used by the run that creates the row.
  */
  const depositAmount = existingDeposit ? Number(existingDeposit.amount) : u.deposit;

  if (!existingDeposit) {
    await rest("deposits", {
      method: "POST",
      headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: profile.id,
        wallet_id: wallet.id,
        amount: u.deposit,
        currency: currency.code,
        phone: u.phone,
        provider: "PAYHERO",
        merchant_reference: merchantReference,
        status: "PENDING",
        idempotency_key: `seed:${BATCH}:${u.index}:deposit`,
        callback_payload: { seeded: true, seedBatch: BATCH, note: "No provider transaction exists for this deposit." },
      }),
    });
  }

  /*
    All five arguments, named. A three-argument call is the shape that was
    ambiguous while 0002's obsolete overload still existed (migration 0021), and
    naming every parameter removes the question entirely.
  */
  /*
    Already settled: nothing to credit. `deposit_credit` is idempotent and would
    say so, but skipping it keeps a resumed run from re-notifying the account and
    from reporting a false failure against a deposit that is correctly COMPLETED.
  */
  const credit =
    existingDeposit?.status === "COMPLETED"
      ? null
      : await rpc("deposit_credit", {
    p_merchant_reference: merchantReference,
    p_provider_transaction_id: `SEED-${BATCH}-${u.index}`,
    p_provider_reference: `SEED-${BATCH}-${u.index}`,
    p_amount: depositAmount,
    p_payload: { seeded: true, seedBatch: BATCH },
  });
  const creditRow = Array.isArray(credit) ? credit[0] : credit;
  if (creditRow && creditRow.credited === false && creditRow.duplicate !== true) {
    failures.push(`${u.email}: deposit_credit reported no credit (${JSON.stringify(creditRow).slice(0, 90)})`);
  }

  /*
    Withdrawals. The amount is capped by the platform's own per-user maximum, so
    a seeded request can never be one the real endpoint would refuse.
  */
  const withdrawalKey = `seed:${BATCH}:${u.index}:withdrawal`;
  const existingWithdrawal = (
    await rest(`withdrawals?select=id,status&idempotency_key=eq.${encodeURIComponent(withdrawalKey)}`)
  )[0];

  let withdrawalId = existingWithdrawal?.id ?? null;
  let withdrawalStatus = existingWithdrawal?.status ?? null;

  if (!withdrawalId) {
    const cap = await rpc("user_withdrawal_max", { p_user_id: profile.id });
    const maxWithdrawable = Number(cap ?? 0);
    /* Sized against the money that actually arrived, not the plan's intention. */
    const amount = Math.min(u.withdrawal, depositAmount / 2, maxWithdrawable);
    if (!(amount >= minWithdrawal)) return;

    const reserved = await rpc("withdrawal_reserve", {
      p_user_id: profile.id,
      p_amount: amount,
      p_phone: u.phone,
      p_idempotency_key: withdrawalKey,
      p_fee: null,
      p_risk_score: 0,
    });

    withdrawalId = Array.isArray(reserved) ? reserved[0]?.id : reserved?.id;
    withdrawalStatus = Array.isArray(reserved) ? reserved[0]?.status : reserved?.status;
    if (!withdrawalId) throw new Error("withdrawal_reserve returned no id");
  }

  /*
    A request left over from an interrupted run is finished here rather than
    skipped: `withdrawal_reserve` has already taken the funds, so abandoning it
    would leave money sitting in the locked balance of an account whose history
    says nothing about why.
  */
  if (u.outcome === "COMPLETED" && withdrawalStatus !== "COMPLETED") {
    /*
      `withdrawal_complete` refuses a request nobody approved
      (WITHDRAWAL_NOT_APPROVED), and it should — that check is the entire point
      of the review step. So the record is approved first, exactly as
      `approveWithdrawal` does it: APPROVED, the reviewing admin, the timestamp.
    */
    await rest(`withdrawals?id=eq.${withdrawalId}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "APPROVED",
        admin_id: adminProfile?.id ?? null,
        admin_approved_at: new Date().toISOString(),
      }),
    });

    await rpc("withdrawal_complete", {
      p_withdrawal_id: withdrawalId,
      p_provider_transaction_id: `SEED-${BATCH}-${u.index}-WD`,
      p_provider_reference: `SEED-${BATCH}-${u.index}-WD`,
      p_response: { seeded: true, seedBatch: BATCH },
    });
  } else if (u.outcome === "REJECTED" && withdrawalStatus !== "REJECTED") {
    await rpc("withdrawal_release", {
      p_withdrawal_id: withdrawalId,
      p_status: "REJECTED",
      p_reason: "Seeded demo record — rejected so the review queue shows both outcomes.",
      p_admin_id: null,
      p_metadata: { seeded: true, seedBatch: BATCH },
    });
  }

  created += 1;
}

/*
  PostgREST accepts a filter list in the query string, and 400 uuids is about
  14 KB of URL — past what most proxies will carry. Batches of 50 keep every
  request comfortably inside the limit.
*/
function chunks(list, size = 50) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/*
  Bounded concurrency: 400 accounts is over a thousand round-trips, and doing
  them one at a time takes minutes, while doing them all at once invites rate
  limiting and half-finished accounts.
*/
for (let i = 0; i < plan.length; i += CONCURRENCY) {
  const slice = plan.slice(i, i + CONCURRENCY);
  const results = await Promise.allSettled(slice.map((u) => seedOne(u)));
  results.forEach((r, k) => {
    if (r.status === "rejected") failures.push(`${slice[k].email}: ${r.reason?.message ?? r.reason}`);
  });
  const done = Math.min(i + CONCURRENCY, plan.length);
  if (done % 40 === 0 || done === plan.length) process.stdout.write(`  … ${done}/${plan.length}\n`);
}

const after = {
  profiles: (await rest("profiles?select=id")).length,
  deposits: (await rest("deposits?select=id")).length,
  withdrawals: (await rest("withdrawals?select=id")).length,
  wallet_transactions: (await rest("wallet_transactions?select=id")).length,
};

console.log(
  `\n  ✓ seeded ${created}/${plan.length} account(s) in batch "${BATCH}"` +
    (resumed > 0 ? ` (${resumed} completed from an earlier run)` : "") +
    "\n",
);
console.log("  table                 before    after   delta");
for (const key of Object.keys(before)) {
  console.log(
    `  ${key.padEnd(20)}${String(before[key]).padStart(7)}${String(after[key]).padStart(9)}${String(after[key] - before[key]).padStart(8)}`,
  );
}

if (failures.length > 0) {
  console.log(`\n  ⚠ ${failures.length} account(s) failed:\n`);
  for (const f of failures.slice(0, 15)) console.log(`      ${f}`);
  if (failures.length > 15) console.log(`      … and ${failures.length - 15} more`);
}

/*
  The invariant worth checking: a seeded wallet's balance must equal the sum of
  its own ledger rows. If it does not, `deposit_credit` or `withdrawal_reserve`
  was bypassed somewhere, which is the one thing this script must never do.
*/
const sample = plan.slice(0, 5);
console.log("\n  balance vs own ledger (first 5):");
for (const u of sample) {
  const profile = (await rest(`profiles?select=id&email=eq.${encodeURIComponent(u.email)}`))[0];
  if (!profile) continue;
  const wallet = (await rest(`wallets?select=available_balance,locked_balance&user_id=eq.${profile.id}`))[0];
  const rows = await rest(`wallet_transactions?select=available_delta,locked_delta&user_id=eq.${profile.id}`);
  const sum = rows.reduce((s, r) => s + Number(r.available_delta), 0);
  const agree = Math.abs(sum - Number(wallet.available_balance)) < 0.0001;
  console.log(
    `    ${agree ? "✓" : "✗"} ${u.email.slice(0, 34).padEnd(36)} balance ${Number(wallet.available_balance).toFixed(2).padStart(10)}  ledger sum ${sum.toFixed(2).padStart(10)}`,
  );
}

console.log(`\n  remove this batch with:`);
console.log(`    npm run seed:users -- --rollback=${BATCH} --apply\n`);
