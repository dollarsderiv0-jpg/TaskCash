#!/usr/bin/env node
/**
 * M-Pesa credential self-check.
 *
 *   node scripts/mpesa-check.js               # validate every credential field
 *   node scripts/mpesa-check.js -k            # + live Daraja OAuth token test
 *   node scripts/mpesa-check.js -c 07XXXXXXXX 1
 *                                             # + STK push end-to-end (sandbox only;
 *                                               complete the prompt on the test phone)
 *   node scripts/mpesa-check.js -b 07XXXXXXXX 10
 *                                             # + B2C payout test (LIVE only, real money!)
 *
 * Reads .env via the same config the server uses. Never prints secrets —
 * only masked previews and pass/fail results.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const config = require('../backend/config');
const mpesa = require('../backend/services/payments/mpesa-provider');

const args = process.argv.slice(2);
const wantKeyTest = args.includes('-k');
const stkIdx = args.indexOf('-c');
const b2cIdx = args.indexOf('-b');
const stkArgs = stkIdx >= 0 ? args.slice(stkIdx + 1) : null;
const b2cArgs = b2cIdx >= 0 ? args.slice(b2cIdx + 1) : null;

let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { failures += 1; console.log(`  ✗ ${msg}`); };
const warn = (msg) => console.log(`  ! ${msg}`);
const mask = (v, keep = 4) => (!v ? '—' : v.length <= keep ? '*'.repeat(v.length) : `${v.slice(0, keep)}…${'*'.repeat(4)}`);

async function main() {
  console.log(`\nWATCHREWARDS M-Pesa check — env=${config.mpesa.env}, app=${config.env}\n`);

  console.log('Collections (STK Push / deposits)');
  if (config.mpesa.key) ok(`MPESA_APP_KEY set (${mask(config.mpesa.key)})`); else bad('MPESA_APP_KEY is empty');
  if (config.mpesa.secret) ok(`MPESA_APP_SECRET set (${mask(config.mpesa.secret)})`); else bad('MPESA_APP_SECRET is empty');
  if (config.mpesa.passkey) ok(`MPESA_PASSKEY set (${mask(config.mpesa.passkey, 6)})`); else bad('MPESA_PASSKEY is empty');
  if (config.mpesa.shortcode) ok(`MPESA_SHORTCODE=${config.mpesa.shortcode}`); else bad('MPESA_SHORTCODE is empty');
  if (/^https:\/\//.test(config.mpesa.callbackUrl || '')) ok(`MPESA_CALLBACK_URL=${config.mpesa.callbackUrl}`);
  else warn('MPESA_CALLBACK_URL is not an https URL — results will fall back to APP_URL, which Daraja cannot reach locally');

  if (wantKeyTest) {
    console.log('\nLive OAuth token test');
    try {
      const token = await mpesa.getAccessToken();
      ok(`Token acquired (${mask(token, 6)}) from ${mpesa.BASE}`);
    } catch (e) {
      bad(e.message);
    }
  }

  if (stkArgs && stkArgs.length >= 1) {
    if (config.mpesa.env !== 'sandbox') {
      warn('STK test skipped: -c is allowed only with MPESA_ENV=sandbox (it would push a real payment prompt)');
    } else {
      console.log(`\nSTK push end-to-end test → ${stkArgs[0]} for KES ${stkArgs[1] || 1}`);
      try {
        const out = await mpesa.createDeposit({
          deposit: { txn_id: 'CHECK' },
          phone: stkArgs[0],
          amount: Number(stkArgs[1] || 1),
        });
        ok(`Push accepted — CheckoutRequestID=${out.providerRef}. Enter the M-Pesa PIN on the phone to complete it.`);
      } catch (e) {
        bad(e.message);
      }
    }
  }

  console.log('\nPayouts (B2C / withdrawals)');
  const b2c = config.mpesa.b2c;
  if (b2c.shortcode) ok(`MPESA_B2C_SHORTCODE=${b2c.shortcode}`); else bad('MPESA_B2C_SHORTCODE is empty');
  if (b2c.initiatorName) ok(`MPESA_B2C_INITIATOR=${b2c.initiatorName}`); else bad('MPESA_B2C_INITIATOR is empty');
  if (b2c.securityCredential) ok(`MPESA_B2C_SECURITY_CREDENTIAL set (${mask(b2c.securityCredential, 6)})`); else bad('MPESA_B2C_SECURITY_CREDENTIAL is empty');
  if (/^https:\/\//.test(b2c.resultUrl || '')) ok(`MPESA_B2C_RESULT_URL=${b2c.resultUrl}`); else warn('MPESA_B2C_RESULT_URL is not set — falling back to the shared callback URL');
  if (b2c.enabled) ok('B2C payout credentials complete'); else bad('B2C incomplete — payouts will stay queued for manual processing');

  if (b2cArgs && b2cArgs.length >= 1) {
    if (config.mpesa.env !== 'production' || !config.isProd) {
      warn('B2C test skipped: -b requires MPESA_ENV=production AND NODE_ENV=production (it sends real money)');
    } else {
      console.log(`\nB2C payout test → ${b2cArgs[0]} for KES ${b2cArgs[1] || 10}  (REAL MONEY)`);
      try {
        const out = await mpesa.createWithdrawal({
          withdrawal: { request_id: 'CHECK' },
          phone: b2cArgs[0],
          amount: Number(b2cArgs[1] || 10),
        });
        ok(`Payout submitted — ConversationID=${out.providerRef}; await the result callback.`);
      } catch (e) {
        bad(e.message);
      }
    }
  }

  console.log(`\n${failures ? `${failures} problem(s) found — fix the ✗ items in .env and re-run.` : 'All required credentials are present.'}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
