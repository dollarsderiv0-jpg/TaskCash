/**
 * WATCHREWARDS UI smoke test.
 *
 * Boots the app against an isolated store, then drives a real headless Chrome
 * over the DevTools Protocol: it signs a demo user in through the API, installs
 * the session cookies in the browser, walks every mobile screen and checks the
 * rendered text against the specification. Console errors and uncaught
 * exceptions fail the run.
 *
 * Run: node scripts/ui-smoke.js      (needs Chrome; CHROME_PATH to override)
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.UI_SMOKE_PORT || 3422);
const CDP_PORT = Number(process.env.UI_SMOKE_CDP_PORT || 9333);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'watchrewards-ui-'));

const CHROME = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => fs.existsSync(p));

const ENV = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(PORT),
  APP_URL: BASE,
  CORS_ORIGINS: BASE,
  DB_MODE: 'json',
  DB_DIR: TMP,
  JWT_SECRET: 'ui-smoke-jwt',
  CSRF_SECRET: 'ui-smoke-csrf',
  PAYMENT_MODE: 'sandbox',
  MPESA_APP_KEY: '',
  MPESA_APP_SECRET: '',
  ADMIN_EMAIL: 'admin@watchrewards.app',
  ADMIN_PASSWORD: 'Admin@1234',
  MIN_WITHDRAWAL: '50',
  WATCH_DAILY_LIMIT: '5',
};

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCREENS = [
  { route: '/home', expect: ['Welcome back', 'Watch. Earn. Withdraw.', "TODAY'S EARNINGS", 'TOTAL EARNINGS', 'WATCHED', 'AVAILABLE BALANCE', 'LIMITED TIME OFFER', 'START WATCHING', 'Home', 'Watch', 'Wallet', 'Team', 'Profile'] },
  { route: '/watch', expect: ['Watch & Earn', 'Complete eligible videos and tasks to earn rewards.', 'WATCH NOW'] },
  { route: '/wallet', expect: ['My Wallet', 'AVAILABLE BALANCE', 'Total Earned', 'Total Deposited', 'Total Withdrawn', 'DEPOSIT', 'WITHDRAW', 'Recent Transactions', 'No Transactions Yet'] },
  { route: '/deposit', expect: ['Deposit via M-Pesa', 'Available Balance', 'Deposit Amount', 'KES 100', 'KES 500', 'KES 1,000', 'KES 2,000', 'KES 5,000', 'CONTINUE', 'Sandbox payment mode'] },
  { route: '/withdraw', expect: ['Withdraw', 'AVAILABLE BALANCE', 'Withdrawal Amount', 'KES 0.00', 'M-Pesa Phone Number', '07XXXXXXXX', 'Minimum withdrawal', 'Processing fee', 'Expected processing', 'REQUEST WITHDRAWAL'] },
  { route: '/transactions', expect: ['Transaction History', 'ALL', 'DEPOSITS', 'EARNINGS', 'WITHDRAWALS', 'No Transactions Yet', 'Your completed deposits, rewards and withdrawals will appear here.'] },
  { route: '/team', expect: ['My Team', 'YOUR REFERRAL CODE', 'COPY', 'YOUR REFERRAL LINK', 'SHARE', 'Total Referrals', 'Active Referrals', 'Referral Rewards', 'How referrals work'] },
  { route: '/rewards', expect: ['Rewards', 'Daily Watch Reward', 'VIEW TASKS', 'Referral Reward', 'Bonus', 'No active bonus'] },
  { route: '/notifications', expect: ['Notifications'] },
  { route: '/profile', expect: ['Profile', 'Personal Information', 'M-Pesa Details', 'Security', 'Transaction History', 'Help & Support', 'Terms & Conditions', 'Privacy Policy', 'Logout'] },
  { route: '/profile/personal', expect: ['Personal Information', 'Full Name', 'Phone Number', 'Email', 'SAVE CHANGES'] },
  { route: '/profile/mpesa', expect: ['M-Pesa Details', 'Registered payout number', 'UPDATE NUMBER'] },
  { route: '/profile/security', expect: ['Security', 'Change Password', 'Login Sessions', 'Logout All Devices'] },
  { route: '/register', expect: ['Create Account', 'Full Name', 'Phone Number', 'Email', 'Confirm Password', 'Referral Code (Optional)', 'Terms & Conditions', 'Privacy Policy'] },
  { route: '/login', expect: ['Welcome Back', 'Sign in to continue watching and earning.', 'Forgot Password?', 'LOGIN', "Don't have an account?", 'Create Account'] },
];

/* ── tiny CDP client ───────────────────────────────────── */
async function connectCdp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not ready */ }
    await sleep(250);
  }
  throw new Error('Could not reach Chrome DevTools');
}

function makeSession(wsUrl) {
  const sock = new WebSocket(wsUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const events = [];
  const errors = [];

  sock.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    events.push(msg.method);
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception ? d.exception.description : d.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value || a.description || '').join(' '));
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1;
    pending.set(id, { resolve, reject });
    sock.send(JSON.stringify({ id, method, params }));
  });

  return {
    ready: new Promise((resolve, reject) => {
      sock.once('open', resolve);
      sock.once('error', reject);
    }),
    send,
    errors,
    events,
    close: () => sock.close(),
  };
}

async function main() {
  if (!CHROME) {
    console.log('Chrome not found — skipping the UI smoke test (set CHROME_PATH to run it).');
    process.exit(0);
  }
  console.log(`\n${'─'.repeat(66)}\n WATCHREWARDS UI smoke test\n chrome: ${CHROME}\n${'─'.repeat(66)}\n`);

  const seed = spawnSync(process.execPath, [path.join('backend', 'db', 'seed.js')], { env: ENV, encoding: 'utf8' });
  if (seed.status !== 0) { console.error(seed.stdout, seed.stderr); throw new Error('seed failed'); }

  const server = spawn(process.execPath, [path.join('backend', 'server.js')], { env: ENV, stdio: 'pipe' });
  const serverLogs = [];
  server.stdout.on('data', (d) => serverLogs.push(String(d)));
  server.stderr.on('data', (d) => serverLogs.push(String(d)));

  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`${BASE}/api/public/health`); if (r.ok) break; } catch { /* wait */ }
    await sleep(250);
  }

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(TMP, 'chrome-profile')}`,
    '--window-size=390,844',
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    const wsUrl = await connectCdp();
    cdp = makeSession(wsUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    // Sign in over the API and install the session cookies in the browser.
    const loginRes = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '0799000001', password: 'Demo@1234' }),
    });
    const loginBody = await loginRes.json();
    check('Demo account signs in through the API', loginRes.status === 200 && Boolean(loginBody.user));
    const setCookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      await cdp.send('Network.setCookie', {
        name: pair.slice(0, idx).trim(),
        value: pair.slice(idx + 1).trim(),
        domain: '127.0.0.1',
        path: '/',
      });
    }

    // innerText reflects rendered text (CSS text-transform included), innerHTML
    // additionally carries attributes such as input placeholders.
    const read = async (expr) => {
      const out = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      return (out.result && out.result.value) || '';
    };
    const text = () => read('document.body.innerText');
    const markup = () => read('document.body.innerHTML');
    const has = (body, needle) => body.toLowerCase().includes(needle.toLowerCase());

    // First load boots the splash → the SPA decides where to go.
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await sleep(2600);
    const landing = await text();
    check('Splash hands over to the app shell', landing.length > 40 && !/WATCH • EARN • WITHDRAW/.test(landing.slice(0, 60)));

    for (const screen of SCREENS) {
      await cdp.send('Runtime.evaluate', { expression: `location.hash = '#${screen.route}'` });
      await sleep(800);
      // Placeholders only exist in the markup, everything else is rendered text.
      const haystack = `${await text()}\n${await markup()}`;
      const missing = screen.expect.filter((s) => !has(haystack, s));
      check(`${screen.route} renders as specified`, missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '');
    }

    // Task card → player flow
    await cdp.send('Runtime.evaluate', { expression: "location.hash = '#/watch'" });
    await sleep(700);
    const started = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const b = document.querySelector('[data-video]'); if (!b) return null; b.click(); return b.getAttribute('data-video'); })()`,
      returnByValue: true,
    });
    await sleep(1500);
    const player = await text();
    check('Watch Now opens the player screen', Boolean(started.result && started.result.value) && /START WATCHING|CLAIM REWARD/.test(player), 'progress + claim CTA');
    check('Player shows reward and progress', /Progress/.test(player) && /KES/.test(player));

    // Bottom navigation switches screens (the player hides the nav by design)
    await cdp.send('Runtime.evaluate', { expression: "location.hash = '#/home'" });
    await sleep(900);
    await cdp.send('Runtime.evaluate', { expression: "document.querySelector('.bottom-nav__item[data-href=\"#/team\"]').click()" });
    await sleep(1200);
    const team = await text();
    check('Bottom navigation works', /My Team/.test(team));

    // Deposit flow up to the pending status screen
    await cdp.send('Runtime.evaluate', { expression: "location.hash = '#/deposit'" });
    await sleep(800);
    await cdp.send('Runtime.evaluate', { expression: "document.querySelector('#deposit-submit').click()" });
    await sleep(1600);
    const depositStatus = await text();
    check('Deposit screen opens the pending status screen',
      /Payment Pending/.test(depositStatus) && /Your payment is being processed/.test(depositStatus) && /Reference/.test(depositStatus));
    check('Deposit status states it is waiting for the provider',
      /waiting for the payment provider/i.test(depositStatus) && /Sandbox environment/i.test(depositStatus));
    check('No fake M-Pesa receipt is shown while pending', !/MpesaReceiptNumber|QK\d{6,}/i.test(depositStatus));

    // Sandbox confirmation → successful, wallet updates
    await cdp.send('Runtime.evaluate', { expression: "document.querySelector('#sandbox-sim') && document.querySelector('#sandbox-sim').click()" });
    await sleep(1700);
    const depositDone = await text();
    check('Verified (sandbox) result flips the deposit to Successful', /Deposit Successful/.test(depositDone));
    check('Sandbox reference is labelled, not disguised as M-Pesa', /SANDBOX-/.test(depositDone));

    await cdp.send('Runtime.evaluate', { expression: "location.hash = '#/wallet'" });
    await sleep(1000);
    const wallet = await text();
    // The deposit screen is prefilled with KES 100, so that is what was sent.
    check('Wallet reflects the verified deposit', /KES 100\.00/.test(wallet) && /M-Pesa deposit|Sandbox deposit/.test(wallet) && /Completed/.test(wallet));

    // Withdrawal confirmation sheet
    await cdp.send('Runtime.evaluate', { expression: "location.hash = '#/withdraw'" });
    await sleep(800);
    await cdp.send('Runtime.evaluate', { expression: `(() => {
      document.querySelector('#wd-amount').value = '100';
      document.querySelector('#wd-phone').value = '0799000001';
      document.querySelector('#wd-submit').click();
    })()` });
    await sleep(1400);
    const sheet = await text();
    check('Withdrawal confirmation sheet appears before submitting',
      /Confirm Withdrawal/.test(sheet) && /You will receive/.test(sheet) && /CANCEL/.test(sheet) && /CONFIRM WITHDRAWAL/.test(sheet));
    check('Confirmation masks the M-Pesa number', /07\*\*\*\*\*\*01/.test(sheet));

    await cdp.send('Runtime.evaluate', { expression: "document.querySelector('#wd-confirm').click()" });
    await sleep(1800);
    const submitted = await text();
    check('Withdrawal request is submitted as Pending',
      /Withdrawal Request Submitted/.test(submitted) && /WRW-/.test(submitted) && /Pending/.test(submitted));

    await cdp.send('Runtime.evaluate', { expression: "location.hash = '#/transactions'" });
    await sleep(1200);
    const txns = await text();
    check('Transaction history lists the real ledger entries',
      /WATCH_REWARD|Deposit|Withdrawal/i.test(txns) && /KES/.test(txns));

    // Admin console: unauthenticated gate
    await cdp.send('Page.navigate', { url: `${BASE}/admin.html` });
    await sleep(1800);
    const gateDom = await text();
    check('Admin console is gated behind admin sign-in', /Admin Console/.test(gateDom) && /SIGN IN/.test(gateDom));

    // Admin console with an admin session
    await cdp.send('Network.clearBrowserCookies');
    const adminLogin = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '0712345678', password: 'Admin@1234' }),
    });
    const adminCookies = adminLogin.headers.getSetCookie ? adminLogin.headers.getSetCookie() : [];
    for (const raw of adminCookies) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      await cdp.send('Network.setCookie', { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim(), domain: '127.0.0.1', path: '/' });
    }
    await cdp.send('Page.navigate', { url: `${BASE}/admin.html` });
    await sleep(2400);
    const admin = await text();
    check('Admin dashboard shows the six database-backed cards',
      ['Registered Users', 'Active Users', 'Total Deposits', 'Total Withdrawals', 'Pending Withdrawals', 'Rewards Issued'].every((s) => has(admin, s)));
    check('Admin sidebar exposes every section',
      ['Dashboard', 'Users', 'Videos', 'Deposits', 'Withdrawals', 'Rewards', 'Referrals', 'Notifications', 'Settings', 'Audit Logs'].every((s) => has(admin, s)));

    for (const section of [['Videos', ['ADD VIDEO', 'Daily limit', 'Title', 'Status']], ['Deposits', ['Transaction ID', 'Payment reference', 'VERIFY']], ['Withdrawals', ['Request ID', 'M-Pesa number']], ['Settings', ['Minimum withdrawal', 'SAVE SETTINGS']], ['Audit Logs', ['Action']]]) {
      await cdp.send('Runtime.evaluate', { expression: `[...document.querySelectorAll('[data-section]')].find(b => b.textContent.trim() === '${section[0]}').click()` });
      await sleep(1500);
      const body = await text();
      const missing = section[1].filter((s) => !has(body, s));
      check(`Admin ${section[0]} view renders`, missing.length === 0, missing.join(', '));
    }

    // ── Responsive rules (section 29): 360 / 390 / 430 px ──
    await cdp.send('Network.clearBrowserCookies');
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      await cdp.send('Network.setCookie', { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim(), domain: '127.0.0.1', path: '/' });
    }
    // Back to the mobile app with the user's session.
    await cdp.send('Page.navigate', { url: `${BASE}/#/home` });
    await sleep(2200);

    for (const width of [360, 390, 430]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      for (const route of ['/home', '/withdraw', '/watch', '/wallet']) {
        await cdp.send('Runtime.evaluate', { expression: `location.hash = '#${route}'` });
        await sleep(700);
        const metrics = await read(`JSON.stringify({ scroll: document.documentElement.scrollWidth, view: window.innerWidth, pad: getComputedStyle(document.querySelector('.page')).paddingLeft })`);
        const m = JSON.parse(metrics || '{}');
        const expectedPad = width === 360 ? '16px' : '20px';
        check(`${route} fits ${width}px without horizontal overflow`, m.scroll <= m.view + 1 && m.pad === expectedPad, `fields=${m.pad}`);
      }
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    const consoleErrors = cdp.errors.filter((e) => !/favicon|net::ERR_ABORTED/i.test(e));
    check('No JavaScript errors in the mobile app', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  } catch (e) {
    check('UI smoke run completed', false, e.message);
    console.error(e);
    console.error(serverLogs.join('').slice(-2000));
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    server.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${'─'.repeat(66)}\n ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log(' Failed:');
    for (const f of failed) console.log(`   ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  console.log(`${'─'.repeat(66)}\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
