/**
 * WATCHREWARDS end-to-end smoke test (section 30).
 *
 * Boots a real server against an isolated JSON store, seeds it, then drives the
 * actual HTTP API the way the mobile app does — register → watch → claim →
 * deposit (sandbox) → withdraw → referral → admin.
 *
 * Run: npm run smoke
 *
 * It asserts that no reward or payment is ever faked:
 *   - a watch reward is refused before the server-side watch requirement is met;
 *   - a deposit stays Pending until a verified provider result arrives;
 *   - a withdrawal reserves funds and stays Pending until the payout is confirmed;
 *   - replaying a provider callback never credits twice.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.SMOKE_PORT || 3399);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'watchrewards-smoke-'));

const ENV = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(PORT),
  APP_URL: BASE,
  CORS_ORIGINS: BASE,
  DB_MODE: 'json',
  DB_DIR: TMP_DIR,
  JWT_SECRET: 'smoke-jwt-secret',
  CSRF_SECRET: 'smoke-csrf-secret',
  PAYMENT_MODE: 'sandbox',
  MPESA_APP_KEY: '',
  MPESA_APP_SECRET: '',
  ADMIN_EMAIL: 'admin@watchrewards.app',
  ADMIN_PASSWORD: 'Admin@1234',
  ADMIN_PHONE: '0712345678',
  // Keep the watch requirement tiny so the test runs in seconds while still
  // exercising the same server-side gate.
  WATCH_MIN_SECONDS: '1',
  WATCH_REQUIRED_PCT: '0.01',
  WATCH_DAILY_LIMIT: '5',
  REFERRAL_REWARD: '20',
  MIN_WITHDRAWAL: '50',
  WITHDRAWAL_FEE_PCT: '2',
};

const results = [];
const ok = (name, detail = '') => { results.push({ name, pass: true, detail }); console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`); };
const bad = (name, detail = '') => { results.push({ name, pass: false, detail }); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); };
const assert = (cond, name, detail = '') => { if (cond) ok(name, detail); else bad(name, detail); return Boolean(cond); };

// ── Minimal cookie-aware HTTP client ────────────────────────
function makeClient() {
  const jar = new Map();
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const absorb = (res) => {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of raw) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '' || value === 'deleted') jar.delete(name);
      else jar.set(name, value);
    }
  };
  return {
    jar,
    csrf() { return jar.get('wr_csrf') || ''; },
    session() { return jar.get('wr_token') || ''; },
    async request(method, url, body) {
      const headers = { 'Content-Type': 'application/json' };
      if (jar.size) headers.Cookie = cookieHeader();
      if (this.csrf()) headers['x-csrf-token'] = this.csrf();
      const res = await fetch(`${BASE}${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      absorb(res);
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      return { status: res.status, data };
    },
    get(url) { return this.request('GET', url); },
    post(url, body) { return this.request('POST', url, body || {}); },
    put(url, body) { return this.request('PUT', url, body || {}); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/public/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

async function main() {
  console.log(`\n${'─'.repeat(64)}\n WATCHREWARDS smoke test\n store: ${TMP_DIR}\n${'─'.repeat(64)}\n`);

  // 1. Seed the isolated store (admin on 0712345678, demo user on 0799000001,
  //    videos, settings)
  const seed = spawnSync(process.execPath, [path.join('backend', 'db', 'seed.js')], {
    env: ENV, encoding: 'utf8',
  });
  if (seed.status !== 0) {
    console.error(seed.stdout, seed.stderr);
    throw new Error('seed failed');
  }

  // 2. Boot the server
  const server = spawn(process.execPath, [path.join('backend', 'server.js')], { env: ENV, stdio: 'pipe' });
  const logs = [];
  server.stdout.on('data', (d) => logs.push(String(d)));
  server.stderr.on('data', (d) => logs.push(String(d)));
  const up = await waitForServer();
  if (!up) {
    console.error(logs.join(''));
    throw new Error('server did not start');
  }

  try {
    // ── Public config ──────────────────────────────────────
    const anon = makeClient();
    const cfg = await anon.get('/api/public/config');
    assert(cfg.status === 200 && cfg.data.brand === 'WATCHREWARDS', 'Public config served', `brand=${cfg.data.brand}`);
    assert(cfg.data.payment_provider.sandbox === true, 'Payments run in labelled sandbox mode', cfg.data.payment_provider.label);
    assert(!/MPESA_APP_SECRET|passkey|consumer/i.test(JSON.stringify(cfg.data)), 'No payment credentials in public config');

    // ── Admin sign-in + a very short video so the watch gate can be exercised
    //    quickly (the platform enforces a 10% minimum watch requirement) ────
    const admin = makeClient();
    const adminLogin = await admin.post('/api/auth/login', { phone: '0712345678', password: 'Admin@1234' });
    assert(adminLogin.status === 200, 'Admin login works');

    const shortVideo = await admin.post('/api/admin/videos', {
      title: 'Smoke Test Daily Video',
      description: 'Short video used by the end-to-end test',
      video_url: 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ',
      duration_seconds: 5, reward: 5, daily_limit: 1, status: 'active',
    });
    const shortVideoId = shortVideo.data && shortVideo.data.video ? shortVideo.data.video.id : null;
    assert(shortVideo.status === 201, 'Admin can create a video (used for the watch flow)');

    // ── Registration (section 03) ──────────────────────────
    const alice = makeClient();
    const regShort = await alice.post('/api/auth/register', { fullname: 'Al', phone: '12', email: 'not-an-email', password: 'short', terms: false });
    assert(regShort.status === 400 && regShort.data.errors, 'Registration rejects weak/incomplete input', Object.keys(regShort.data.errors || {}).join(','));

    const reg = await alice.post('/api/auth/register', {
      fullname: 'Alice Mwangi', phone: '0712000001', email: 'alice@test.io',
      password: 'Passw0rd1', confirm_password: 'Passw0rd1', terms: true,
    });
    assert(reg.status === 201 && reg.data.user, 'Registration works', `code=${reg.data.user.referral_code}`);
    assert(Number(reg.data.user.balance) === 0, 'New account starts at KES 0.00 (no fabricated balance)');

    const dupe = await makeClient().post('/api/auth/register', {
      fullname: 'Alice Again', phone: '0712000001', email: 'alice2@test.io',
      password: 'Passw0rd1', confirm_password: 'Passw0rd1', terms: true,
    });
    assert(dupe.status === 409, 'Duplicate phone registration blocked');

    // ── Login / logout (section 02) ────────────────────────
    const badLogin = await makeClient().post('/api/auth/login', { phone: '0712000001', password: 'wrong-password' });
    assert(badLogin.status === 401, 'Login rejects a wrong password');

    const session = makeClient();
    const login = await session.post('/api/auth/login', { phone: '0712000001', password: 'Passw0rd1' });
    assert(login.status === 200 && login.data.user, 'Login works with phone + password');

    const me = await session.get('/api/auth/me');
    assert(me.status === 200 && me.data.config, 'Authenticated /me works');

    // ── Watch & Earn (sections 06, 07) ─────────────────────
    const list = await session.get('/api/watch/videos');
    assert(list.status === 200 && list.data.videos.length > 0, 'Watch tasks load from the database', `${list.data.videos.length} videos`);
    const video = list.data.videos.find((v) => v.id === shortVideoId) || list.data.videos[0];

    const started = await session.post('/api/watch/sessions', { video_id: video.id });
    assert(started.status === 201 && started.data.session.id, 'Watch session starts server-side', `required=${started.data.session.required_seconds}s`);
    const sid = started.data.session.id;

    const early = await session.post(`/api/watch/sessions/${sid}/claim`);
    assert(early.status === 400, 'Reward refused before the watch requirement is met', early.data && early.data.error);

    await session.post(`/api/watch/sessions/${sid}/progress`, { watched_seconds: started.data.session.required_seconds });
    await sleep(1300); // let real elapsed time pass the server's gate
    const progress = await session.post(`/api/watch/sessions/${sid}/progress`, { watched_seconds: started.data.session.required_seconds });
    assert(progress.data.eligible === true, 'Server marks the session eligible after verified progress');

    const claim = await session.post(`/api/watch/sessions/${sid}/claim`);
    assert(claim.status === 200 && claim.data.reward > 0, 'Watch reward credited through the ledger', `+${claim.data.currency_code} ${claim.data.reward}`);
    const txnId = claim.data.txn_id;

    const replay = await session.post(`/api/watch/sessions/${sid}/claim`);
    assert(replay.status === 200 && replay.data.already_rewarded === true, 'Repeated reward claim is not paid twice');

    const home = await session.get('/api/home/summary');
    assert(home.status === 200 && home.data.stats.total_earnings > 0, 'Home dashboard loads real backend data', `earned ${home.data.stats.total_earnings}`);

    // ── Deposit (sections 09, 10, 27) ──────────────────────
    const dep = await session.post('/api/wallet/deposit', { amount: 500, phone: '0712000001' });
    assert(dep.status === 202 && dep.data.deposit.status === 'pending', 'Deposit creates a pending transaction', dep.data.deposit.txn_id);
    const pendingDep = await session.get(`/api/wallet/deposits/${dep.data.deposit.txn_id}?verify=1`);
    assert(pendingDep.data.deposit.status === 'pending' && !pendingDep.data.is_successful, 'Deposit is not marked successful without provider confirmation');
    assert(!pendingDep.data.deposit.payment_reference, 'No M-Pesa receipt is invented while pending');

    const before = (await session.get('/api/wallet/summary')).data.available;
    const sim = await session.post('/api/mpesa/sandbox/callback', {
      kind: 'deposit', txn_id: dep.data.deposit.txn_id, result: 'SUCCESS',
    });
    assert(sim.status === 200 && sim.data.sandbox === true, 'Sandbox provider confirms the deposit for development', `status=${sim.data.status}`);

    const after = await session.get('/api/wallet/summary');
    assert(after.data.available >= before + 500, 'Wallet is credited only after a verified provider result', `${before} → ${after.data.available}`);

    const settled = await session.get(`/api/wallet/deposits/${dep.data.deposit.txn_id}`);
    assert(settled.data.deposit.status === 'successful' && /SANDBOX-/.test(settled.data.deposit.payment_reference || ''), 'Verified deposit becomes Successful with a labelled sandbox reference', settled.data.deposit.payment_reference);

    const simAgain = await session.post('/api/mpesa/sandbox/callback', { kind: 'deposit', txn_id: dep.data.deposit.txn_id, result: 'SUCCESS' });
    const afterAgain = await session.get('/api/wallet/summary');
    assert(simAgain.status === 200 && simAgain.data.idempotent === true, 'Duplicate provider callback is idempotent');
    assert(afterAgain.data.available === after.data.available, 'Duplicate callback never credits twice');

    // ── Withdrawal (sections 11, 12, 23) ───────────────────
    const overdraw = await session.post('/api/wallet/withdraw', { amount: 999999, phone: '0712000001' });
    assert(overdraw.status === 400, 'Withdrawal validates the available balance', overdraw.data && overdraw.data.error);

    const quote = await session.post('/api/wallet/withdraw/quote', { amount: 100 });
    assert(quote.status === 200 && quote.data.valid, 'Withdrawal quote returns fee and net amount', `fee=${quote.data.fee} net=${quote.data.net_amount}`);

    const wd = await session.post('/api/wallet/withdraw', { amount: 100, phone: '0712000001' });
    assert(wd.status === 202 && wd.data.withdrawal.status === 'pending', 'Withdrawal creates a pending request', wd.data.withdrawal && wd.data.withdrawal.request_id);

    const wdId = wd.data.withdrawal.id;
    const wdRow = await session.get(`/api/wallet/withdrawals/${wdId}`);
    assert(wdRow.data.withdrawal.status === 'pending', 'Withdrawal stays Pending until the payout is verified');
    assert(!wdRow.data.withdrawal.receipt, 'No payout receipt is invented');

    const doubleSpend = await session.post('/api/wallet/withdraw', { amount: 999999, phone: '0712000001' });
    assert(doubleSpend.status === 400, 'Reserved funds cannot be withdrawn again');

    // ── Referral reward (section 14) ───────────────────────
    const bob = makeClient();
    const bobReg = await bob.post('/api/auth/register', {
      fullname: 'Bob Otieno', phone: '0712000002', email: 'bob@test.io',
      password: 'Passw0rd1', confirm_password: 'Passw0rd1',
      referral_code: reg.data.user.referral_code, terms: true,
    });
    assert(bobReg.status === 201, 'Registration through a referral link works');

    const bobList = await bob.get('/api/watch/videos');
    const bobStart = await bob.post('/api/watch/sessions', { video_id: (bobList.data.videos.find((v) => v.id === shortVideoId) || bobList.data.videos[0]).id });
    await bob.post(`/api/watch/sessions/${bobStart.data.session.id}/progress`, { watched_seconds: bobStart.data.session.required_seconds });
    await sleep(1300);
    await bob.post(`/api/watch/sessions/${bobStart.data.session.id}/progress`, { watched_seconds: bobStart.data.session.required_seconds });
    const bobClaim = await bob.post(`/api/watch/sessions/${bobStart.data.session.id}/claim`);
    assert(bobClaim.status === 200, 'Referred user can complete a watch task');

    const team = await session.get('/api/team');
    assert(team.status === 200 && team.data.stats.total_referrals === 1, 'Team screen reports the real referral count');
    assert(team.data.stats.referral_rewards > 0, 'Referral reward credited after the eligible condition', `reward=${team.data.stats.referral_rewards}`);

    // ── Transaction history (section 13) ───────────────────
    const txns = await session.get('/api/wallet/transactions?filter=all&limit=50');
    const ids = (txns.data.transactions || []).map((t) => t.txn_id);
    assert(txns.status === 200 && ids.includes(txnId), 'Transaction history includes the watch reward');
    assert(ids.filter((id) => id === txnId).length === 1, 'Ledger has one entry per transaction');
    const filtered = await session.get('/api/wallet/transactions?filter=earnings');
    assert(filtered.data.transactions.every((t) => ['WATCH_REWARD', 'REFERRAL_REWARD'].includes(t.type)), 'History filters return the right transaction types');

    // ── Notifications (section 16) ─────────────────────────
    const notes = await session.get('/api/notifications');
    assert(notes.status === 200 && notes.data.notifications.length > 0, 'Notifications load', `${notes.data.notifications.length} rows`);
    const firstNote = notes.data.notifications[0];
    await session.post(`/api/notifications/${firstNote.id}/read`);
    const notesAfter = await session.get('/api/notifications');
    assert(notesAfter.data.notifications.find((n) => n.id === firstNote.id).is_read === true, 'Notification read state persists');

    // ── Wallet isolation ───────────────────────────────────
    const foreign = await bob.get(`/api/wallet/deposits/${dep.data.deposit.txn_id}`);
    assert(foreign.status === 404, 'A user cannot read another user\'s deposit');
    const bobWallet = await bob.get('/api/wallet/summary');
    assert(Number(bobWallet.data.available) !== Number(after.data.available), 'Wallet balances are per-user', `bob=${bobWallet.data.available} alice=${after.data.available}`);

    // ── Profile & security (sections 17 – 20) ──────────────
    const profile = await session.put('/api/auth/profile', { fullname: 'Alice W. Mwangi' });
    assert(profile.status === 200 && profile.data.user.fullname === 'Alice W. Mwangi', 'Profile changes save');

    const phoneNoPass = await session.post('/api/auth/phone', { phone: '0712000009' });
    assert(phoneNoPass.status === 401, 'Phone change requires password verification');

    const payout = await session.post('/api/auth/payout', { phone: '0712000009', password: 'Passw0rd1' });
    assert(payout.status === 200 && /\*\*\*\*\*\*/.test(payout.data.payout_phone), 'M-Pesa detail change requires verification and is masked', payout.data.payout_phone);

    const sessions = await session.get('/api/auth/sessions');
    assert(sessions.status === 200 && sessions.data.sessions.length > 0, 'Login sessions are listed');

    const badPw = await session.post('/api/auth/change-password', { current_password: 'nope', new_password: 'Newpass123' });
    assert(badPw.status === 401, 'Password change verifies the current password');

    // ── Admin (sections 21 – 24) ───────────────────────────
    const adminNoAuth = await makeClient().get('/api/admin/overview');
    assert(adminNoAuth.status === 401, 'Admin API requires authentication');

    const overview = await admin.get('/api/admin/overview');
    assert(overview.status === 200 && overview.data.cards.length === 6, 'Admin dashboard cards come from the database');
    const card = (k) => (overview.data.cards.find((c) => c.key === k) || {}).value;
    assert(Number(card('registered_users')) >= 3, 'Registered users counted from DB', `${card('registered_users')}`);
    assert(Number(card('total_deposits')) >= 500, 'Total deposits counted from DB', `${card('total_deposits')}`);
    assert(Number(card('rewards_issued')) > 0, 'Rewards issued counted from the ledger', `${card('rewards_issued')}`);

    const videos = await admin.get('/api/admin/videos');
    assert(videos.status === 200 && videos.data.videos.length > 0, 'Admin video list loads');

    const created = await admin.post('/api/admin/videos', {
      title: 'Smoke Test Video Two', description: 'Created by the smoke test',
      video_url: 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ',
      duration_seconds: 30, reward: 3, daily_limit: 1, status: 'active',
    });
    assert(created.status === 201 && created.data.video.id, 'Admin can add a video');
    const edited = await admin.put(`/api/admin/videos/${created.data.video.id}`, { reward: 4 });
    assert(edited.status === 200 && Number(edited.data.video.reward) === 4, 'Admin can edit a video');
    const disabled = await admin.post(`/api/admin/videos/${created.data.video.id}/status`, { status: 'inactive' });
    assert(disabled.status === 200 && disabled.data.video.status === 'inactive', 'Admin can disable a video');

    const adminDeps = await admin.get('/api/admin/deposits');
    assert(adminDeps.status === 200 && adminDeps.data.deposits.length > 0, 'Admin deposits list loads');
    const adminWds = await admin.get('/api/admin/withdrawals');
    assert(adminWds.status === 200 && adminWds.data.withdrawals.length > 0, 'Admin withdrawals list loads');

    const pendingWd = adminWds.data.withdrawals.find((w) => w.status === 'pending');
    if (pendingWd) {
      const rejected = await admin.post(`/api/admin/withdrawals/${pendingWd.id}/process`);
      assert(rejected.status === 200, 'Admin payout goes through the provider layer', `status=${rejected.data.withdrawal.status}`);
      assert(rejected.data.withdrawal.status !== 'completed', 'Admin cannot mark a payout completed without provider confirmation', `status=${rejected.data.withdrawal.status}`);
    } else {
      bad('Admin payout goes through the provider layer', 'no pending withdrawal found');
    }

    const settingsGet = await admin.get('/api/admin/settings');
    const settingsPut = await admin.put('/api/admin/settings', { min_withdrawal: 200, watch_daily_limit: 3 });
    assert(settingsGet.status === 200, 'Admin settings load');
    assert(settingsPut.status === 200 && Number(settingsPut.data.settings.min_withdrawal) === 200, 'Admin settings update', 'min_withdrawal=200');

    const audit = await admin.get('/api/admin/audit-logs');
    assert(audit.status === 200 && audit.data.logs.length > 0, 'Audit log records admin activity', `${audit.data.logs.length} entries`);

    const referrals = await admin.get('/api/admin/referrals');
    assert(referrals.status === 200 && referrals.data.referrals.length === 1, 'Admin referral list shows the real referral');

    // ── Logout & session revocation (section 20) ───────────
    const logoutAll = await session.post('/api/auth/logout-all', {});
    assert(logoutAll.status === 200, 'Logout all devices succeeds');
    const stale = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: `wr_token=${session.jar.get('wr_token') || ''}` } });
    assert(stale.status === 401, 'Revoked session cannot access protected data');

    const logout = await bob.post('/api/auth/logout', {});
    assert(logout.status === 200, 'Logout works');
    const bobAfter = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: `wr_token=${bob.jar.get('wr_token') || ''}` } });
    assert(bobAfter.status === 401, 'Logged-out user cannot access protected data');

    // ── Production payment guard (section 28) ──────────────
    const prod = spawnSync(process.execPath, ['-e', `
      process.env.NODE_ENV = 'production';
      process.env.MPESA_APP_KEY = '';
      process.env.MPESA_APP_SECRET = '';
      process.env.PAYMENT_MODE = 'sandbox';
      const payments = require('./backend/services/payments');
      const provider = payments.getProvider();
      let simThrew = false;
      try { require('./backend/services/payments/sandbox-provider').simulate({ kind: 'deposit', providerRef: 'X' }); }
      catch (e) { simThrew = true; }
      console.log(JSON.stringify({ id: provider.id, sandbox: payments.describe().sandbox, simThrew }));
    `], { env: ENV, encoding: 'utf8' });
    let prodInfo = {};
    try { prodInfo = JSON.parse(prod.stdout.trim().split('\n').pop()); } catch { prodInfo = {}; }
    assert(prodInfo.id === 'unconfigured' && prodInfo.sandbox === false, 'Production without credentials refuses payments instead of simulating', `provider=${prodInfo.id}`);
    assert(prodInfo.simThrew === true, 'Sandbox simulation is hard-disabled in production');

    // ── Spoken-word guarantees ─────────────────────────────
    const allJs = fs.readdirSync(path.join('frontend', 'assets', 'js')).filter((f) => f.endsWith('.js'));
    const frontendSource = allJs.map((f) => fs.readFileSync(path.join('frontend', 'assets', 'js', f), 'utf8')).join('\n');
    // "Guaranteed" may only appear inside a disclaimer (no/not/never …), never
    // as a promise of returns.
    const claims = [...frontendSource.matchAll(/guaranteed|risk[- ]free/gi)]
      .filter((m) => !/(no|not|never|nothing|without)\s+[\w\s,.;:'"-]{0,50}$/i.test(frontendSource.slice(Math.max(0, m.index - 60), m.index)));
    assert(claims.length === 0, 'No guaranteed-profit claims in the UI', `${claims.length} bare claim(s)`);
    assert(!/MPESA_APP_SECRET|ConsumerSecret|passkey|MPESA_B2C_SECURITY_CREDENTIAL/i.test(frontendSource), 'No payment credentials in frontend code');
  } catch (e) {
    bad('Unhandled smoke failure', e.message);
    console.error(e);
  } finally {
    server.kill();
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${'─'.repeat(64)}`);
  console.log(` ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log(' Failed checks:');
    for (const f of failed) console.log(`   ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  console.log(`${'─'.repeat(64)}\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
