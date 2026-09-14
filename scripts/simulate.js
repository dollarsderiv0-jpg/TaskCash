/**
 * DEV LOAD SIMULATOR — 500 simulated users making deposits and withdrawals.
 *
 * Every 2 seconds, a random simulated user fires a deposit + a withdrawal with
 * different (random) amounts, exercising the real wallet endpoints through the
 * platform's currency-aware rules. This mirrors real traffic so admins can
 * watch the wallet/withdrawal queues move in the admin panel.
 *
 * ⚠️ Dev/demo tooling only. Never run against production.
 *
 * Usage:
 *   npm run simulate           (uses http://localhost:3000)
 *   BASE_URL=http://localhost:3000 npm run simulate
 *   USERS=100 INTERVAL_MS=2000 npm run simulate
 */
const http = require('http');
const { URL } = require('url');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const USERS = Math.max(parseInt(process.env.USERS, 10) || 500, 1);
const INTERVAL = Math.max(parseInt(process.env.INTERVAL_MS, 10) || 2000, 250);
const CURRENCIES = ['KES', 'USD', 'GBP', 'NGN', 'TZS', 'UGX', 'ZAR', 'GHS', 'INR', 'EUR'];
const COUNTRY_FOR_CURRENCY = { KES: 'KE', USD: 'US', GBP: 'GB', NGN: 'NG', TZS: 'TZ', UGX: 'UG', ZAR: 'ZA', GHS: 'GH', INR: 'IN', EUR: 'DE' };

// In-memory simulated users (id, currency, cookies). Not persisted.
const simUsers = [];

function req(path, { method = 'GET', body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const r = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(data); } catch { /* empty */ }
        const setCookie = res.headers['set-cookie'];
        resolve({ status: res.statusCode, json, setCookie });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function cookiesFrom(res) {
  const jar = {};
  (res.setCookie || []).forEach((line) => {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  });
  return jar;
}
const jarToString = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

/** Batch-register the simulated users (spread across the currency mix). */
async function registerUsers() {
  console.log(`[sim] registering ${USERS} simulated users across ${CURRENCIES.length} currencies…`);
  let registered = 0;
  for (let i = 0; i < USERS; i++) {
    const cur = CURRENCIES[i % CURRENCIES.length];
    const cc = COUNTRY_FOR_CURRENCY[cur];
    const suffix = `${Date.now().toString(36)}${i.toString(36)}`.slice(-8);
    const email = `sim_${suffix}@simulator.local`;
    const password = `Sim@${suffix}1`;
    const res = await req('/api/auth/register', {
      method: 'POST',
      body: {
        fullname: `Sim User ${i + 1}`,
        username: `sim_${suffix}`,
        email,
        phone: cc === 'KE' ? `2547${String(10000000 + i).slice(-8)}` : `+${1000000000 + i}`,
        country_code: cc,
        password,
      },
    });
    if (res.status === 201) {
      const jar = cookiesFrom(res);
      simUsers.push({ index: i, currency: cur, country: cc, jar, csrf: res.json.csrf || jar.taskcash_csrf || '' });
      registered++;
    } else if (i % 50 === 0) {
      console.warn(`[sim] user ${i + 1} register failed: ${res.status} ${JSON.stringify(res.json).slice(0, 120)}`);
    }
    if (i % 25 === 24) console.log(`[sim] …${i + 1}/${USERS} processed`);
  }
  console.log(`[sim] ${registered}/${USERS} simulated users ready`);
  return registered;
}

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/** One activity cycle: deposit + withdrawal with different random amounts. */
async function simulateUser(u) {
  const cookie = jarToString(u.jar);
  const headers = { cookie, 'x-csrf-token': u.csrf };
  const depositAmt = rand(5, 300);
  const withdrawAmt = rand(2, 40);

  // Deposit (M-Pesa is only implemented for KE — others get the friendly
  // country-aware error, which still exercises the code path).
  const dep = await req('/api/wallet/deposit', {
    method: 'POST', cookie, headers,
    body: { amount: depositAmt, phone: u.country === 'KE' ? `2547${rand(10000000, 99999999)}` : `+${rand(1000000000, 9999999999)}` },
  });
  const wd = await req('/api/wallet/withdraw', {
    method: 'POST', cookie, headers,
    body: { amount: withdrawAmt, method: u.country === 'KE' ? 'mpesa' : 'bank', destination: u.country === 'KE' ? `2547${rand(10000000, 99999999)}` : `ACCT${rand(1000000, 9999999)}` },
  });
  return { depositAmt, withdrawAmt, dep: dep.status, wd: wd.status };
}

async function tick() {
  const batch = simUsers.slice();
  const results = await Promise.allSettled(batch.map(simulateUser));
  const ok = results.filter((r) => r.status === 'fulfilled');
  const depOk = ok.filter((r) => r.value.dep === 201 || r.value.dep === 200).length;
  const wdOk = ok.filter((r) => r.value.wd === 200).length;
  const sample = ok[0] ? ok[0].value : null;
  console.log(
    `[sim] tick ${new Date().toISOString().slice(11, 19)} · ${batch.length} users · ` +
    `deposits ${depOk}/${batch.length} · withdrawals ${wdOk}/${batch.length}` +
    (sample ? ` · sample ${sample.depositAmt}/${sample.withdrawAmt} (dep ${sample.dep}, wd ${sample.wd})` : '')
  );
}

(async () => {
  console.log(`[sim] target ${BASE} · ${USERS} users · every ${INTERVAL}ms`);
  const ready = await registerUsers();
  if (!ready) {
    console.error('[sim] no users registered — is the server running? Start it with: npm run dev');
    process.exit(1);
  }
  setInterval(() => tick().catch((e) => console.warn('[sim] tick failed:', e.message)), INTERVAL);
})();
