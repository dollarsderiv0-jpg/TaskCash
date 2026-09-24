/**
 * Fee arithmetic checks.
 *
 * These run against the compiled `lib/fees.ts` — the same module the form, the
 * dialog and the ledger import — so a change to the rate or the rounding cannot
 * pass here while failing in the UI.
 *
 * Run with `npm run test:fees` (compiles first, then executes this file).
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fees = require("./.build/fees.js");

const {
  WITHDRAWAL_FEE_RATE,
  WITHDRAWAL_FEE_PCT,
  quoteWithdrawal,
  feeOn,
  feeForTransaction,
  netForTransaction,
} = fees;

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1;
  else failures.push(`${name}\n     expected ${JSON.stringify(expected)}\n     received ${JSON.stringify(actual)}`);
}

function checkDeep(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) passed += 1;
  else failures.push(`${name}\n     expected ${b}\n     received ${a}`);
}

/* --- the headline rule ---------------------------------------------------- */

check("rate is 10%", WITHDRAWAL_FEE_RATE, 0.1);
check("pct is 10", WITHDRAWAL_FEE_PCT, 10);

checkDeep("1,000 → 100 fee, 900 net", quoteWithdrawal(1000), {
  gross: 1000,
  fee: 100,
  net: 900,
  feeRate: 0.1,
});

checkDeep("the minimum 100 withdrawal still nets the user money", quoteWithdrawal(100), {
  gross: 100,
  fee: 10,
  net: 90,
  feeRate: 0.1,
});

/* --- rounding ------------------------------------------------------------- */

/*
 * Money must be rounded to the cent, not left as a float, or a stored fee can
 * drift from the figure the user was shown. 333 * 0.1 is 33.300000000000004.
 */
checkDeep("333 rounds the fee to the cent", quoteWithdrawal(333), {
  gross: 333,
  fee: 33.3,
  net: 299.7,
  feeRate: 0.1,
});

checkDeep("gross and net always re-add to the requested amount", quoteWithdrawal(1234.56), {
  gross: 1234.56,
  fee: 123.46,
  net: 1111.1,
  feeRate: 0.1,
});

/* Round-trip: net + fee must equal gross exactly for a spread of amounts. */
let roundTripOk = true;
for (const amount of [100, 101, 333, 999.99, 1000, 2500, 12345.67, 100000]) {
  const q = quoteWithdrawal(amount);
  const recomposed = Math.round((q.fee + q.net) * 100) / 100;
  if (recomposed !== q.gross) {
    roundTripOk = false;
    failures.push(`fee + net != gross at ${amount}: ${q.fee} + ${q.net} = ${recomposed}`);
  }
}
if (roundTripOk) passed += 1;

/* --- invalid input -------------------------------------------------------- */

for (const bad of [0, -1, -1000, NaN, Infinity, -Infinity]) {
  checkDeep(`quote(${String(bad)}) is zeroed`, quoteWithdrawal(bad), {
    gross: 0,
    fee: 0,
    net: 0,
    feeRate: 0.1,
  });
}

/* --- the stored-row fallbacks -------------------------------------------- */

check("feeOn derives 10%", feeOn(1000), 100);
check("a recorded fee wins over the rate", feeForTransaction(1000, 42), 42);
check("a missing fee falls back to the rate", feeForTransaction(1000, undefined), 100);
check("a recorded zero fee is honoured", feeForTransaction(1000, 0), 0);
check("net is derived from gross - fee", netForTransaction(1000, 100, undefined), 900);
check("a recorded net wins", netForTransaction(1000, 100, 850), 850);

/* --- report --------------------------------------------------------------- */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`\n✗ fees: ${failures.length} of ${total} checks failed\n`);
  for (const failure of failures) console.error(`  • ${failure}\n`);
  process.exit(1);
}

console.log(`✓ fees: ${passed}/${total} checks passed`);
