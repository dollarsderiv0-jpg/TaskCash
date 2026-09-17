/* ============================================================================
   WATCHREWARDS — mobile app (vanilla JS, hash router)
   Screens 01–20, 25 and 26 of the specification.
   Money only ever comes from the API; the client never invents a balance,
   a reward or a payment confirmation.
   ========================================================================== */
(() => {
  'use strict';

  const view = document.getElementById('view');
  const sheetHost = document.getElementById('sheet-host');
  const toastHost = document.getElementById('toasts');

  /* ── tiny DOM/format helpers ─────────────────────────── */
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const el = (sel, root = document) => root.querySelector(sel);
  const els = (sel, root = document) => [...root.querySelectorAll(sel)];

  const money = (amount, code) => `${code || state.currency} ${(Number(amount) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const money0 = (amount, code) => `${code || state.currency} ${(Number(amount) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const clock = (seconds) => {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const dateShort = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  };
  const dateTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  };
  const timeAgo = (iso) => {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return dateShort(iso);
  };
  const titleCase = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const initials = (name) => String(name || 'WR').split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

  /* ── session-aware API client ────────────────────────── */
  const cookie = (name) => {
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : '';
  };

  const API = {
    async request(path, { method = 'GET', body, retry = true } = {}) {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const csrf = cookie('wr_csrf');
      if (csrf) headers['x-csrf-token'] = csrf;

      const res = await fetch(path, {
        method,
        headers,
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      let data = null;
      try { data = await res.json(); } catch { data = null; }

      // A stale CSRF cookie is refreshed by any GET, then retried once.
      if (res.status === 403 && retry && /CSRF/i.test((data && data.error) || '')) {
        await fetch('/api/public/config', { credentials: 'same-origin' });
        return this.request(path, { method, body, retry: false });
      }

      if (res.status === 401) {
        const code = data && data.code;
        if (code === 'SESSION_EXPIRED' || code === 'SESSION_REVOKED' || (!data || !data.error)) {
          if (state.user) {
            state.user = null;
            toast('Your session ended. Please sign in again.', 'warn');
            go('#/login');
          }
        }
      }

      if (!res.ok) {
        const err = new Error((data && data.error) || `Request failed (${res.status})`);
        err.status = res.status;
        err.data = data || {};
        throw err;
      }
      return data;
    },
    get(path) { return this.request(path); },
    post(path, body) { return this.request(path, { method: 'POST', body: body || {} }); },
    put(path, body) { return this.request(path, { method: 'PUT', body: body || {} }); },
  };

  /* ── app state ───────────────────────────────────────── */
  const state = {
    user: null,
    config: null,
    currency: 'KES',
    route: '',
    nav: true,
    player: null,
    txOffset: 0,
    txFilter: 'all',
    txLoading: false,
    depPoll: null,
  };

  const isSandbox = () => Boolean(state.config && state.config.payment_provider && state.config.payment_provider.sandbox);

  /* ── toasts ──────────────────────────────────────────── */
  function toast(message, type = 'success', ms = 4200) {
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    toastHost.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity 250ms ease';
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 260);
    }, ms);
  }

  /* ── icons (original WATCHREWARDS marks) ─────────────── */
  const I = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.8V21h14V9.8"/><path d="M10 21v-6h4v6"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4.5" width="19" height="15" rx="3"/><path d="M10 9.2l5 2.8-5 2.8z" fill="currentColor" stroke="none"/></svg>',
    wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="13" rx="3"/><path d="M2.5 10h19"/><circle cx="17" cy="14.2" r="1.2" fill="currentColor" stroke="none"/></svg>',
    team: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.4 6-5.4s6 2.1 6 5.4"/><path d="M16 8.4a3 3 0 0 1 0 5.6"/><path d="M18 20c0-2.2-.6-3.7-1.6-4.7"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M4.8 20c0-3.6 3.2-5.8 7.2-5.8s7.2 2.2 7.2 5.8"/></svg>',
    bell: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15.5V11a6 6 0 1 0-12 0v4.5L4.5 18h15z"/><path d="M10 21h4"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    back: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
    eye: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 6.8A9.9 9.9 0 0 1 12 6.5c6 0 9.5 5.5 9.5 5.5a17 17 0 0 1-2.6 3.2"/><path d="M6.3 8.1A17 17 0 0 0 2.5 12s3.5 5.5 9.5 5.5a9.6 9.6 0 0 0 3.4-.6"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M6 13l6 6 6-6"/></svg>',
    up: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.2 2"/></svg>',
    alert: '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.4" r="0.9" fill="currentColor"/></svg>',
    empty: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18"/><path d="M8 14.5h4"/></svg>',
    person: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.4"/><path d="M5 20c0-3.5 3.1-5.6 7-5.6s7 2.1 7 5.6"/></svg>',
    phone: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M10.5 18.5h3"/></svg>',
    shield: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z"/><path d="M9.2 12.2l2 2 3.6-4"/></svg>',
    list: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h16M4 12h16M4 17.5h10"/></svg>',
    help: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.6 2.3c-.7.4-1.2.9-1.2 1.7v.4"/><circle cx="12" cy="17" r="0.9" fill="currentColor"/></svg>',
    doc: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/></svg>',
    logout: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5H6v14h9"/><path d="M12 12h9"/><path d="M18 9l3 3-3 3"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6a3 3 0 0 0-3 3v6.5A2.5 2.5 0 0 0 5.5 15"/></svg>',
    share: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M5 14v5.5h14V14"/></svg>',
    gift: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M3 12h18"/><path d="M12 8v12"/><path d="M8.5 8a2.5 2.5 0 1 1 3.5-2.3A2.5 2.5 0 1 1 15.5 8"/></svg>',
  };

  /* ── shared partials ─────────────────────────────────── */
  const header = (opts = {}) => {
    const unread = opts.unread ? '<span class="icon-btn__dot"></span>' : '';
    return `
      <header class="app-header">
        ${opts.back
          ? `<button class="back" data-back aria-label="Go back">${I.back}</button>
             <div class="center grow" style="font-size:19px;font-weight:750">${esc(opts.title || '')}</div>
             <span style="width:38px"></span>`
          : `<div class="app-header__logo">${esc(opts.logo || 'WATCHREWARDS')}</div>
             <button class="icon-btn" data-notifications aria-label="Notifications">${I.bell}${unread}</button>`}
      </header>`;
  };

  const navItems = [
    { id: 'home', label: 'Home', icon: I.home, href: '#/home' },
    { id: 'watch', label: 'Watch', icon: I.play, href: '#/watch' },
    { id: 'wallet', label: 'Wallet', icon: I.wallet, href: '#/wallet' },
    { id: 'team', label: 'Team', icon: I.team, href: '#/team' },
    { id: 'profile', label: 'Profile', icon: I.user, href: '#/profile' },
  ];
  const activeNav = (route) => {
    if (route.startsWith('watch') || route.startsWith('rewards')) return 'watch';
    if (route.startsWith('wallet') || route.startsWith('deposit') || route.startsWith('withdraw') || route.startsWith('transactions')) return 'wallet';
    if (route.startsWith('team')) return 'team';
    if (route.startsWith('profile')) return 'profile';
    return 'home';
  };
  const bottomNav = (route) => `
    <nav class="bottom-nav" aria-label="Main navigation">
      ${navItems.map((n) => `
        <button class="bottom-nav__item ${activeNav(route) === n.id ? 'is-active' : ''}" data-href="${n.href}">
          ${n.icon}<span>${n.label}</span>
        </button>`).join('')}
    </nav>`;

  const emptyState = ({ title, message, action, href, icon = I.empty }) => `
    <div class="empty">
      <div class="empty__icon">${icon}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(message)}</p>
      ${action ? `<button class="btn btn-primary btn-sm" style="width:auto" ${href ? `data-href="${href}"` : 'data-action="retry"'}>${esc(action)}</button>` : ''}
    </div>`;

  const loadingBlock = (rows = 3) => `
    <div class="stack gap" style="margin-top:14px">
      ${Array.from({ length: rows }, () => '<div class="skeleton" style="height:86px"></div>').join('')}
    </div>`;

  const errorState = (message) => emptyState({
    title: 'Something went wrong',
    message: message || 'We could not load this screen. Check your connection and try again.',
    action: 'Try again',
    icon: I.alert,
  });

  const sandboxNotice = () => (isSandbox() ? `
    <div class="notice notice--warning" style="margin-top:14px">
      <strong>Sandbox payment mode.</strong> No real M-Pesa request is sent in this environment,
      and nothing here represents a completed M-Pesa payment.
    </div>` : '');

  const statusBadge = (txn) => {
    const cls = txn.status === 'COMPLETED' ? 'success' : txn.status === 'FAILED' ? 'danger' : txn.status === 'REVERSED' ? 'muted' : 'warning';
    return `<span class="badge badge--${cls}">${esc(txn.status_label || titleCase(txn.status))}</span>`;
  };

  const txnRow = (txn) => {
    const inbound = txn.direction === 'in';
    const icon = txn.type === 'DEPOSIT' ? I.down : txn.type === 'WITHDRAWAL' || txn.type === 'FEE' ? I.up : I.gift;
    return `
      <div class="txn">
        <div class="txn__icon ${inbound ? 'txn__icon--in' : 'txn__icon--out'}">${icon}</div>
        <div class="txn__body">
          <div class="txn__desc">${esc(txn.description || titleCase(txn.type))}</div>
          <div class="txn__date">${esc(dateTime(txn.created_at))}</div>
        </div>
        <div class="txn__right">
          <div class="txn__amount ${inbound ? 'in' : 'out'}">${inbound ? '+' : '−'} ${esc(money(txn.amount, txn.currency_code))}</div>
          <div class="txn__status ${String(txn.status || '').toLowerCase()}">${esc(txn.status_label || titleCase(txn.status))}</div>
        </div>
      </div>`;
  };

  /* ── sheets ──────────────────────────────────────────── */
  function sheet(html, { onClose } = {}) {
    const back = document.createElement('div');
    back.className = 'backdrop';
    back.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
    back.addEventListener('click', (e) => {
      if (e.target === back) close();
    });
    function close() {
      back.remove();
      if (onClose) onClose();
    }
    sheetHost.appendChild(back);
    els('[data-close]', back).forEach((b) => b.addEventListener('click', close));
    return { node: back, close };
  }

  /* ── router ──────────────────────────────────────────── */
  const routes = {};

  function parse() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [pathPart, queryPart] = raw.split('?');
    const segments = pathPart.split('/').filter(Boolean);
    const params = Object.fromEntries(new URLSearchParams(queryPart || ''));
    return { segments, params };
  }

  function go(hash) {
    if (location.hash === hash) router.handle();
    else location.hash = hash;
  }

  /** Re-renders the current screen (used by retry / refresh actions). */
  function render() { return router.handle(); }

  function wireCommon() {
    els('[data-href]').forEach((b) => b.addEventListener('click', () => go(b.getAttribute('data-href'))));
    els('[data-back]').forEach((b) => b.addEventListener('click', () => {
      if (history.length > 1) history.back(); else go('#/home');
    }));
    els('[data-notifications]').forEach((b) => b.addEventListener('click', () => go('#/notifications')));
    els('[data-action="retry"]').forEach((b) => b.addEventListener('click', () => render()));
    els('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      const value = b.getAttribute('data-copy');
      try { await navigator.clipboard.writeText(value); toast('Copied to clipboard'); }
      catch { toast('Copy failed — long-press to select instead', 'warn'); }
    }));
    els('[data-share]').forEach((b) => b.addEventListener('click', async () => {
      const url = b.getAttribute('data-share');
      const data = { title: 'WATCHREWARDS', text: 'Join me on WATCHREWARDS — watch eligible videos and earn rewards.', url };
      if (navigator.share) { try { await navigator.share(data); } catch { /* cancelled */ } }
      else { try { await navigator.clipboard.writeText(url); toast('Referral link copied'); } catch { toast('Could not copy link', 'warn'); } }
    }));
    els('[data-password-toggle]').forEach((b) => b.addEventListener('click', () => {
      const input = b.parentElement.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.innerHTML = show ? I.eyeOff : I.eye;
      b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    }));
  }

  /* ── 02 — LOGIN ──────────────────────────────────────── */
  routes.login = async () => `      <div class="auth" style="padding:calc(40px + env(safe-area-inset-top)) var(--page-x) 40px;min-height:100dvh;display:flex;flex-direction:column">
      <div class="auth__head">
        <div class="auth__logo">WATCHREWARDS</div>
        <h1>Welcome Back</h1>
        <p class="auth__lead">Sign in to continue watching and earning.</p>
      </div>
      <form id="login-form" novalidate>
        <div class="field">
          <label for="login-phone">Phone Number</label>
          <div class="field__control">
            <input class="input" id="login-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel"
              placeholder="07XXXXXXXX" required />
          </div>
          <div class="field__error" data-error-for="phone"></div>
        </div>
        <div class="field">
          <label for="login-password">Password</label>
          <div class="field__control">
            <input class="input" id="login-password" name="password" type="password" autocomplete="current-password"
              placeholder="Enter your password" required />
            <button class="field__eye" type="button" data-password-toggle aria-label="Show password">${I.eye}</button>
          </div>
          <div class="field__error" data-error-for="password"></div>
        </div>
        <div class="field field--inline-link" style="margin-top:12px">
          <a href="#/forgot">Forgot Password?</a>
        </div>
        <button class="btn btn-primary" id="login-submit" type="submit">LOGIN</button>
      </form>
      <p class="auth__foot">Don't have an account? <a href="#/register">Create Account</a></p>
    </div>`;

  routes.login.wire = () => {
    const form = el('#login-form');
    const submit = el('#login-submit');
    const setError = (field, message) => {
      const box = el(`[data-error-for="${field}"]`);
      if (box) box.textContent = message || '';
      const input = el(`#login-${field}`);
      if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const phone = el('#login-phone').value.trim();
      const password = el('#login-password').value;
      setError('phone', ''); setError('password', '');

      if (!phone) return setError('phone', 'Enter your phone number');
      if (!password) return setError('password', 'Enter your password');

      submit.disabled = true;
      submit.innerHTML = '<span class="spinner"></span>';
      try {
        const out = await API.post('/api/auth/login', { phone, password });
        state.user = out.user;
        state.currency = out.user.currency_code || 'KES';
        toast(`Welcome back, ${out.user.fullname.split(' ')[0]}`);
        go('#/home');
      } catch (err) {
        const field = (err.data && err.data.errors && err.data.errors.password) ? 'password' : 'phone';
        setError(field, err.message);
        submit.disabled = false;
        submit.textContent = 'LOGIN';
      }
    });
  };

  /* ── 03 — REGISTRATION ───────────────────────────────── */
  routes.register = async ({ params }) => `
    <div class="auth auth--register" style="padding:calc(24px + env(safe-area-inset-top)) var(--page-x) 32px;min-height:100dvh">
      <div class="auth__bar">
        <button class="auth__back" data-href="#/login" aria-label="Back to login">${I.back}</button>
        <h1>Create Account</h1>
        <span></span>
      </div>
      <form id="register-form" novalidate>
        <div class="field">
          <label for="reg-fullname">Full Name</label>
          <div class="field__control">
            <input class="input" id="reg-fullname" name="fullname" placeholder="Your full name" autocomplete="name" required />
          </div>
          <div class="field__error" data-error-for="fullname"></div>
        </div>
        <div class="field">
          <label for="reg-phone">Phone Number</label>
          <div class="field__control">
            <input class="input" id="reg-phone" name="phone" type="tel" inputmode="tel" placeholder="07XXXXXXXX" autocomplete="tel" required />
          </div>
          <div class="field__error" data-error-for="phone"></div>
        </div>
        <div class="field">
          <label for="reg-email">Email</label>
          <div class="field__control">
            <input class="input" id="reg-email" name="email" type="email" placeholder="you@example.com" autocomplete="email" required />
          </div>
          <div class="field__error" data-error-for="email"></div>
        </div>
        <div class="field">
          <label for="reg-password">Password</label>
          <div class="field__control">
            <input class="input" id="reg-password" name="password" type="password" placeholder="8+ characters, letters and numbers" autocomplete="new-password" required />
            <button class="field__eye" type="button" data-password-toggle aria-label="Show password">${I.eye}</button>
          </div>
          <div class="field__error" data-error-for="password"></div>
        </div>
        <div class="field">
          <label for="reg-confirm">Confirm Password</label>
          <div class="field__control">
            <input class="input" id="reg-confirm" name="confirm_password" type="password" placeholder="Re-enter your password" autocomplete="new-password" required />
          </div>
          <div class="field__error" data-error-for="confirm_password"></div>
        </div>
        <div class="field">
          <label for="reg-referral">Referral Code (Optional)</label>
          <div class="field__control">
            <input class="input" id="reg-referral" name="referral_code" placeholder="e.g. WR5A25A452" value="${esc(params.ref || '')}" />
          </div>
          <div class="field__error" data-error-for="referral_code"></div>
        </div>
        <label class="check">
          <input type="checkbox" id="reg-terms" />
          <span>I agree to the <a href="#/terms">Terms &amp; Conditions</a> and <a href="#/privacy">Privacy Policy</a>.</span>
        </label>
        <div class="field__error" data-error-for="terms"></div>
        <button class="btn btn-primary" id="register-submit" type="submit">Create Account</button>
      </form>
      <p class="auth__foot">Already have an account? <a href="#/login">Login</a></p>
    </div>`;

  routes.register.wire = () => {
    const form = el('#register-form');
    const submit = el('#register-submit');
    const setError = (field, message) => {
      const box = el(`[data-error-for="${field}"]`);
      if (box) box.textContent = message || '';
      const input = el(`#reg-${field}`);
      if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
    };
    const payload = () => ({
      fullname: el('#reg-fullname').value.trim(),
      phone: el('#reg-phone').value.trim(),
      email: el('#reg-email').value.trim(),
      password: el('#reg-password').value,
      confirm_password: el('#reg-confirm').value,
      referral_code: el('#reg-referral').value.trim(),
      terms: el('#reg-terms').checked,
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = payload();
      ['fullname', 'phone', 'email', 'password', 'confirm_password', 'referral_code', 'terms'].forEach((f) => setError(f, ''));

      const local = {};
      if (!body.fullname || body.fullname.length < 3) local.fullname = 'Enter your full name';
      if (!/^(07\d{8}|01\d{8}|2547\d{8}|2541\d{8})$/.test(body.phone.replace(/[^\d]/g, ''))) local.phone = 'Enter a valid Kenyan phone number';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) local.email = 'Enter a valid email address';
      if (!(body.password.length >= 8 && /[a-zA-Z]/.test(body.password) && /\d/.test(body.password))) local.password = 'Use 8+ characters with letters and numbers';
      if (body.password !== body.confirm_password) local.confirm_password = 'Passwords do not match';
      if (!body.terms) local.terms = 'Please accept the Terms & Conditions and Privacy Policy';

      if (Object.keys(local).length) {
        Object.entries(local).forEach(([f, m]) => setError(f, m));
        return;
      }

      submit.disabled = true;
      submit.innerHTML = '<span class="spinner"></span>';
      try {
        const out = await API.post('/api/auth/register', body);
        state.user = out.user;
        state.currency = out.user.currency_code || 'KES';
        toast('Account created — welcome to WATCHREWARDS');
        go('#/home');
      } catch (err) {
        const errs = (err.data && err.data.errors) || {};
        if (Object.keys(errs).length) Object.entries(errs).forEach(([f, m]) => setError(f, m));
        else setError('phone', err.message);
        submit.disabled = false;
        submit.textContent = 'Create Account';
      }
    });
  };

  /* ── Forgot / reset password ─────────────────────────── */
  routes.forgot = async () => `
    <div class="auth" style="padding:calc(40px + env(safe-area-inset-top)) var(--page-x) 32px;min-height:100dvh">
      <div class="auth__bar">
        <button class="auth__back" data-href="#/login" aria-label="Back to login">${I.back}</button>
        <h1>Reset Password</h1>
        <span></span>
      </div>
      <p class="auth__lead">Enter the phone number or email on your account and we will send a reset link.</p>
      <form id="forgot-form" novalidate>
        <div class="field">
          <label for="forgot-id">Phone Number or Email</label>
          <div class="field__control">
            <input class="input" id="forgot-id" placeholder="07XXXXXXXX" required />
          </div>
          <div class="field__error" data-error-for="forgot"></div>
        </div>
        <button class="btn btn-primary" id="forgot-submit" type="submit">SEND RESET LINK</button>
      </form>
      <p class="auth__foot"><a href="#/login">Back to login</a></p>
    </div>`;

  routes.forgot.wire = () => {
    el('#forgot-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const identifier = el('#forgot-id').value.trim();
      const box = el('[data-error-for="forgot"]');
      if (!identifier) { box.textContent = 'Enter your phone number or email'; return; }
      box.textContent = '';
      const btn = el('#forgot-submit');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
      try {
        const out = await API.post('/api/auth/forgot-password', { phone: identifier, email: identifier });
        toast(out.message || 'If that account exists, a reset link has been sent');
        if (out.reset_url) toast('Sandbox: reset link printed on the server console', 'warn', 6000);
        go('#/login');
      } catch (err) {
        box.textContent = err.message;
        btn.disabled = false; btn.textContent = 'SEND RESET LINK';
      }
    });
  };

  routes['reset-password'] = async ({ params }) => `
    <div class="auth" style="padding:calc(40px + env(safe-area-inset-top)) var(--page-x) 32px;min-height:100dvh">
      <div class="auth__head"><div class="auth__logo">WATCHREWARDS</div><h1>New Password</h1></div>
      <form id="reset-form" novalidate>
        <div class="field">
          <label for="reset-password">New Password</label>
          <div class="field__control">
            <input class="input" id="reset-password" type="password" placeholder="8+ characters, letters and numbers" required />
            <button class="field__eye" type="button" data-password-toggle aria-label="Show password">${I.eye}</button>
          </div>
          <div class="field__error" data-error-for="password"></div>
        </div>
        <div class="field">
          <label for="reset-confirm">Confirm Password</label>
          <div class="field__control"><input class="input" id="reset-confirm" type="password" placeholder="Re-enter your password" required /></div>
          <div class="field__error" data-error-for="confirm"></div>
        </div>
        <button class="btn btn-primary" id="reset-submit" type="submit">UPDATE PASSWORD</button>
      </form>
    </div>`;

  routes['reset-password'].wire = ({ params }) => {
    el('#reset-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = el('#reset-password').value;
      const confirm = el('#reset-confirm').value;
      const errP = el('[data-error-for="password"]');
      const errC = el('[data-error-for="confirm"]');
      errP.textContent = ''; errC.textContent = '';
      if (!(password.length >= 8 && /[a-zA-Z]/.test(password) && /\d/.test(password))) { errP.textContent = 'Use 8+ characters with letters and numbers'; return; }
      if (password !== confirm) { errC.textContent = 'Passwords do not match'; return; }
      const btn = el('#reset-submit');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
      try {
        await API.post('/api/auth/reset-password', { token: params.token, password, confirm_password: confirm });
        toast('Password updated — please sign in');
        go('#/login');
      } catch (err) {
        errP.textContent = err.message;
        btn.disabled = false; btn.textContent = 'UPDATE PASSWORD';
      }
    });
  };

  /* ── 04 + 05 — HOME ──────────────────────────────────── */
  routes.home = async () => {
    const out = await API.get('/api/home/summary');
    state.user = { ...(state.user || {}), ...out.user };
    state.currency = out.stats.currency_code || state.currency;
    const s = out.stats;
    return `
      <div class="page">
        ${header({ unread: out.unread_notifications > 0 })}
        <h1 class="greeting">${esc(out.greeting || 'Welcome back 👋')}</h1>
        <p class="greeting__sub">${esc(out.subline || 'Watch. Earn. Withdraw.')}</p>

        <section class="promo" aria-label="Promotional offer">
          <div class="promo__tag">LIMITED TIME OFFER</div>
          <div class="promo__main">Watch. Earn. Withdraw.</div>
          <p class="promo__text">Complete eligible activities and receive rewards according to the platform rules.</p>
          <button class="promo__btn" data-href="#/watch">START WATCHING</button>
        </section>

        <div class="stats-grid">
          <div class="stat">
            <div class="stat__label">Today's Earnings</div>
            <div class="stat__value" id="stat-today">${esc(money(s.today_earnings, s.currency_code))}</div>
          </div>
          <div class="stat">
            <div class="stat__label">Total Earnings</div>
            <div class="stat__value">${esc(money(s.total_earnings, s.currency_code))}</div>
          </div>
          <div class="stat">
            <div class="stat__label">Watched</div>
            <div class="stat__value">${Number(s.watched) || 0}</div>
          </div>
          <div class="stat">
            <div class="stat__label">Available Balance</div>
            <div class="stat__value">${esc(money(s.available_balance, s.currency_code))}</div>
          </div>
        </div>
      </div>
      ${bottomNav('home')}`;
  };

  /* ── 06 — WATCH & EARN ───────────────────────────────── */
  routes.watch = async () => {
    const out = await API.get('/api/watch/videos');
    const daily = out.daily || { limit: 0, completed: 0, remaining: 0 };
    const list = out.videos || [];
    return `
      <div class="page">
        ${header({ back: false })}
        <div class="screen-head">
          <div class="screen-head__row">
            <button class="back" data-href="#/home" aria-label="Back">${I.back}</button>
            <h1>Watch &amp; Earn</h1>
          </div>
          <p class="screen-sub">Complete eligible videos and tasks to earn rewards.</p>
        </div>
        ${list.length ? `
          <div class="row between" style="margin-bottom:12px">
            <span class="muted small">Daily progress</span>
            <span class="badge">${daily.completed} / ${daily.limit} today</span>
          </div>
          ${list.map((v) => `
            <article class="task">
              <div class="task__thumb">
                <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2.5" y="4.5" width="19" height="15" rx="3"/><path d="M10 9.2l5 2.8-5 2.8z" fill="currentColor" stroke="none"/></svg>
              </div>
              <div class="task__body">
                <div class="task__title">${esc(v.title)}</div>
                <div class="task__meta">
                  <span>${esc(clock(v.duration_seconds))}</span>
                  <span>${esc(money0(v.reward, v.currency_code))}</span>
                </div>
                <div class="task__meta"><span class="muted small">${v.status === 'completed' ? 'Completed today' : v.completed_today > 0 ? `${v.completed_today}/${v.daily_limit} done today` : 'Available now'}</span></div>
              </div>
              <div class="task__actions">
                <button class="task__btn ${v.status === 'completed' ? 'done' : ''}" data-video="${v.id}" ${v.status === 'completed' ? 'disabled' : ''}>
                  ${v.status === 'completed' ? 'DONE' : v.status === 'in_progress' ? 'RESUME' : 'WATCH NOW'}
                </button>
              </div>
            </article>`).join('')}
        ` : emptyState({
          title: 'No videos available',
          message: 'New eligible videos are added regularly. Please check back shortly.',
          action: 'Refresh',
          icon: I.play,
        })}
      </div>
      ${bottomNav('watch')}`;
  };

  routes.watch.wire = () => {
    els('[data-video]').forEach((b) => b.addEventListener('click', () => {
      if (b.disabled) return;
      b.disabled = true;
      b.textContent = '…';
      go(`#/watch/${b.getAttribute('data-video')}`);
    }));
  };

  /* ── 07 — VIDEO / TASK PLAYER ────────────────────────── */
  routes.player = async ({ id }) => {
    if (!id) return `<div class="page">${header({ back: true, title: 'Daily Video' })}${emptyState({ title: 'Video not found', message: 'Choose a task from the Watch & Earn list.', action: 'View tasks', href: '#/watch' })}</div>`;

    const started = await API.post('/api/watch/sessions', { video_id: Number(id) });
    const { session, video } = started;
    const required = Number(session.required_seconds);
    const startProgress = Number(session.watched_seconds) || 0;

    return `
      <div class="page no-nav">
        ${header({ back: true, title: video.title })}
        <div class="player" id="player-box">
          ${/^https?:\/\//i.test(video.video_url)
            ? `<iframe id="player-media" src="${esc(video.video_url)}" title="${esc(video.title)}" allow="accelerometer; autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>`
            : '<div class="player__placeholder">Video source unavailable</div>'}
        </div>

        <div class="player-meta">
          <div>
            <div class="player-meta__title">${esc(video.title)}</div>
            <p class="muted small" style="margin-top:4px">${esc(video.description || '')}</p>
          </div>
          <div class="player-meta__reward">${esc(money(video.reward, video.currency_code))}</div>
        </div>

        <div class="row between" style="margin-top:18px">
          <span class="muted small">Progress</span>
          <span class="small" id="progress-label">${Math.round((startProgress / (Number(video.duration_seconds) || 1)) * 100)}%</span>
        </div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div class="progress__bar" id="progress-bar"></div>
        </div>

        <div id="player-status" class="muted small" style="margin-top:12px">
          Watch at least ${esc(clock(required))} of this video to unlock the reward.
        </div>

        <button class="btn btn-primary" id="player-cta" style="margin-top:18px" data-session="${session.id}" data-required="${required}" data-duration="${video.duration_seconds}" data-start="${startProgress}">START WATCHING</button>
      </div>`;
  };

  routes.player.wire = async ({ id }) => {
    const cta = el('#player-cta');
    if (!cta) return;
    const bar = el('#progress-bar');
    const label = el('#progress-label');
    const status = el('#player-status');
    const sessionId = cta.getAttribute('data-session');
    const required = Number(cta.getAttribute('data-required'));
    const duration = Number(cta.getAttribute('data-duration')) || required;
    let watched = Number(cta.getAttribute('data-start')) || 0;
    let startedAt = null;
    let ticker = null;
    let eligible = watched >= required;
    let media = null;
    try { media = el('#player-media'); } catch { media = null; }
    const isVideoTag = media && media.tagName === 'VIDEO';

    const paint = () => {
      const pct = Math.min(100, Math.round((watched / duration) * 1000) / 10);
      bar.style.width = `${pct}%`;
      label.textContent = `${pct}%`;
      const progressWrap = bar.parentElement;
      progressWrap.setAttribute('aria-valuenow', String(Math.round(pct)));
    };
    paint();

    async function report() {
      // Prefer real media playback position when the source is a <video>.
      if (isVideoTag && media && !media.paused) watched = Math.max(watched, Math.floor(media.currentTime));
      else if (startedAt) watched = Math.max(watched, Math.floor((Date.now() - startedAt) / 1000));
      watched = Math.min(watched, duration);
      try {
        const out = await API.post(`/api/watch/sessions/${sessionId}/progress`, { watched_seconds: watched });
        watched = Number(out.watched_seconds) || watched;
        eligible = Boolean(out.eligible);
        paint();
        if (eligible) {
          status.textContent = 'Watch requirement met — your reward is ready to claim.';
          cta.textContent = 'CLAIM REWARD';
        } else {
          const left = Math.max(0, required - watched);
          status.textContent = `${left}s left before this reward can be claimed.`;
        }
      } catch (e) {
        status.textContent = e.message;
      }
    }

    async function begin() {
      startedAt = Date.now();
      cta.disabled = true;
      cta.textContent = 'WATCHING…';
      if (isVideoTag && media) { try { await media.play(); } catch { /* autoplay blocked */ } }
      await report();
      ticker = setInterval(report, 2000);
    }

    state.player = {
      stop() { if (ticker) clearInterval(ticker); ticker = null; },
    };

    cta.addEventListener('click', async () => {
      if (!eligible) { await begin(); return; }

      if (ticker) { clearInterval(ticker); ticker = null; }
      cta.disabled = true;
      cta.innerHTML = '<span class="spinner"></span>';
      try {
        const out = await API.post(`/api/watch/sessions/${sessionId}/claim`);
        await report().catch(() => {});
        toast(out.message || 'Reward received');
        const videoTitle = el('.player-meta__title') ? el('.player-meta__title').textContent : 'Daily Video';
        view.innerHTML = `
          <div class="page no-nav">
            ${header({ back: true, title: 'Daily Video' })}
            <div class="status">
              <div class="status__icon status__icon--success">${I.check}</div>
              <h1>Reward Received</h1>
              <p>+ ${esc(money(out.reward, out.currency_code))}</p>
              <div class="card">
                <div class="kv"><span>Video</span><span>${esc(videoTitle)}</span></div>
                <div class="kv"><span>Amount</span><span>${esc(money(out.reward, out.currency_code))}</span></div>
                <div class="kv"><span>Status</span><span>Completed</span></div>
                <div class="kv"><span>Transaction</span><span>${esc(out.txn_id)}</span></div>
                <div class="kv"><span>Wallet balance</span><span>${esc(money(out.balance, out.currency_code))}</span></div>
              </div>
              <button class="btn btn-primary" style="margin-top:18px" data-href="#/watch">BACK TO TASKS</button>
            </div>
          </div>`;
        wireCommon();
      } catch (err) {
        cta.disabled = false;
        cta.textContent = eligible ? 'CLAIM REWARD' : 'START WATCHING';
        status.textContent = err.message;
        toast(err.message, 'warn');
        if (err.status === 400) { await begin(); }
      }
    });
  };

  /* ── 08 — WALLET ─────────────────────────────────────── */
  routes.wallet = async () => {
    const [summary, txns] = await Promise.all([
      API.get('/api/wallet/summary'),
      API.get('/api/wallet/transactions?filter=all&limit=5'),
    ]);
    state.currency = summary.currency_code || state.currency;
    return `
      <div class="page">
        ${header()}
        <div class="screen-head">
          <div class="screen-head__row">
            <button class="back" data-href="#/home" aria-label="Back">${I.back}</button>
            <h1>My Wallet</h1>
          </div>
        </div>

        <div class="balance-card">
          <div>
            <div class="balance-card__label">AVAILABLE BALANCE</div>
            <div class="balance-card__value">${esc(money(summary.available, summary.currency_code))}</div>
          </div>
          <div class="balance-card__rows">
            <div>Total Earned<strong>${esc(money(summary.total_earned, summary.currency_code))}</strong></div>
            <div>Total Deposited<strong>${esc(money(summary.total_deposited, summary.currency_code))}</strong></div>
            <div>Total Withdrawn<strong>${esc(money(summary.total_withdrawn, summary.currency_code))}</strong></div>
          </div>
        </div>

        <div class="wallet-actions">
          <button class="btn btn-deposit" data-href="#/deposit">DEPOSIT</button>
          <button class="btn btn-withdraw" data-href="#/withdraw">WITHDRAW</button>
        </div>

        ${Number(summary.pending) > 0 ? `<div class="notice notice--warning" style="margin-top:14px">${esc(money(summary.pending, summary.currency_code))} is on hold for a withdrawal that is still awaiting provider confirmation.</div>` : ''}

        <div class="row between" style="margin:22px 0 12px">
          <h2 class="card__title">Recent Transactions</h2>
          <button class="btn btn-sm btn-ghost btn-auto" data-href="#/transactions">View all</button>
        </div>

        ${txns.transactions.length
          ? `<div class="txn-list">${txns.transactions.map(txnRow).join('')}</div>`
          : emptyState({
            title: 'No Transactions Yet',
            message: 'Your completed deposits, rewards and withdrawals will appear here.',
            action: 'Start watching',
            href: '#/watch',
          })}
      </div>
      ${bottomNav('wallet')}`;
  };

  /* ── 09 — DEPOSIT ────────────────────────────────────── */
  routes.deposit = async () => {
    const [summary, config] = await Promise.all([
      API.get('/api/wallet/summary'),
      API.get('/api/wallet/config'),
    ]);
    const presets = [100, 500, 1000, 2000, 5000];
    return `
      <div class="page">
        ${header({ back: true, title: 'Deposit via M-Pesa' })}
        <div class="balance-card" style="min-height:120px">
          <div>
            <div class="balance-card__label">Available Balance</div>
            <div class="balance-card__value">${esc(money(summary.available, summary.currency_code))}</div>
          </div>
        </div>

        <div class="card" style="margin-top:18px">
          <div class="card__title">Deposit Amount</div>
          <div class="field" style="margin-top:12px;max-width:none">
            <label for="deposit-amount" class="small muted">Amount (${esc(config.currency_code)})</label>
            <div class="field__control">
              <input class="input" id="deposit-amount" type="number" inputmode="decimal" min="${config.min_deposit}" max="${config.max_deposit}" placeholder="KES 100" value="100" />
            </div>
            <div class="field__error" data-error-for="amount"></div>
          </div>
          <div class="presets">
            ${presets.map((p) => `<button class="preset ${p === 100 ? 'is-active' : ''}" data-preset="${p}">KES ${p.toLocaleString('en-US')}</button>`).join('')}
          </div>
          <p class="muted small" style="margin-top:12px">Minimum ${esc(money0(config.min_deposit, config.currency_code))} · Maximum ${esc(money0(config.max_deposit, config.currency_code))}. Funds are credited only after your M-Pesa payment is confirmed.</p>
        </div>

        <div class="field" style="margin-top:16px;max-width:none">
          <label for="deposit-phone">M-Pesa Phone Number</label>
          <div class="field__control">
            <input class="input" id="deposit-phone" type="tel" inputmode="tel" placeholder="07XXXXXXXX" value="${esc(state.user && state.user.phone ? state.user.phone : '')}" />
          </div>
          <div class="field__error" data-error-for="phone"></div>
        </div>

        <button class="btn btn-primary" id="deposit-submit" style="margin-top:20px">CONTINUE</button>
        ${sandboxNotice()}
      </div>`;
  };

  routes.deposit.wire = () => {
    const amountInput = el('#deposit-amount');
    const idempotencyKey = uuid();
    els('[data-preset]').forEach((b) => b.addEventListener('click', () => {
      els('[data-preset]').forEach((x) => x.classList.remove('is-active'));
      b.classList.add('is-active');
      amountInput.value = b.getAttribute('data-preset');
    }));

    el('#deposit-submit').addEventListener('click', async () => {
      const amount = Number(amountInput.value);
      const phone = el('#deposit-phone').value.trim();
      const errAmount = el('[data-error-for="amount"]');
      const errPhone = el('[data-error-for="phone"]');
      errAmount.textContent = ''; errPhone.textContent = '';

      if (!(amount > 0)) { errAmount.textContent = 'Enter a deposit amount'; return; }
      if (!/^(07\d{8}|01\d{8}|2547\d{8}|2541\d{8})$/.test(phone.replace(/[^\d]/g, ''))) { errPhone.textContent = 'Enter a valid M-Pesa number (07XXXXXXXX)'; return; }

      const btn = el('#deposit-submit');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
      try {
        const out = await API.post('/api/wallet/deposit', { amount, phone, idempotency_key: idempotencyKey });
        toast(out.message || 'Deposit created — waiting for M-Pesa confirmation', 'warn', 6000);
        go(`#/deposit/${out.deposit.txn_id}`);
      } catch (err) {
        errAmount.textContent = err.message;
        btn.disabled = false; btn.textContent = 'CONTINUE';
      }
    });
  };

  /* ── 10 — DEPOSIT STATUS ─────────────────────────────── */
  async function depositStatusScreen(txnId, sandboxFlag) {
    const load = async (verify) => API.get(`/api/wallet/deposits/${encodeURIComponent(txnId)}${verify ? '?verify=1' : ''}`);
    let out = await load(false);

    const paint = async (verify = false) => {
      if (verify) out = await load(true);
      const d = out.deposit;
      const pending = d.status === 'pending';
      const failed = d.status === 'failed';
      const sandbox = sandboxFlag || isSandbox();

      view.innerHTML = `
        <div class="page no-nav">
          ${header({ back: false, title: 'Deposit via M-Pesa' })}
          <div class="status">
            <div class="status__icon ${d.status === 'successful' ? 'status__icon--success' : failed ? 'status__icon--danger' : ''}">
              ${d.status === 'successful' ? I.check : failed ? I.alert : I.clock}
            </div>
            <h1>${d.status === 'successful' ? 'Deposit Successful' : failed ? 'Deposit Failed' : 'Payment Pending'}</h1>
            <p>${d.status === 'successful'
              ? `${esc(money(d.amount, d.currency_code))} has been added to your wallet.`
              : failed
                ? 'The payment could not be confirmed.'
                : 'Your payment is being processed.'}</p>

            <div class="card">
              <div class="kv"><span>Amount</span><span>${esc(money(d.amount, d.currency_code))}</span></div>
              <div class="kv"><span>Reference</span><span>${esc(d.txn_id)}</span></div>
              <div class="kv"><span>Status</span><span>${esc(d.status_label)}</span></div>
              ${d.payment_reference ? `<div class="kv"><span>Payment reference</span><span>${esc(d.payment_reference)}</span></div>` : ''}
              ${d.failure_reason ? `<div class="kv"><span>Reason</span><span>${esc(d.failure_reason)}</span></div>` : ''}
            </div>

            ${pending ? `<div class="notice" style="margin-top:16px;text-align:left">
              We are waiting for the payment provider's verified result. This screen will update automatically — no confirmation is shown until the provider confirms it.
              ${out.detail ? `<br><span class="small">${esc(out.detail)}</span>` : ''}
            </div>` : ''}

            ${pending && sandbox ? `<div class="notice notice--warning" style="margin-top:12px;text-align:left">
              Sandbox environment: no real M-Pesa request was sent. Simulating here only tests the app's own flow.
            </div>
            <button class="btn btn-ghost" style="margin-top:12px" id="sandbox-sim">SIMULATE SANDBOX CONFIRMATION</button>` : ''}

            <div class="row gap" style="margin-top:18px;width:100%">
              <button class="btn btn-ghost" data-href="#/wallet">Back to wallet</button>
              ${pending ? '<button class="btn btn-primary" id="dep-check">CHECK STATUS</button>' : failed ? '<button class="btn btn-primary" data-href="#/deposit">Try Again</button>' : '<button class="btn btn-primary" data-href="#/home">Continue</button>'}
            </div>
          </div>
        </div>`;

      wireCommon();

      const checkBtn = el('#dep-check');
      if (checkBtn) checkBtn.addEventListener('click', async () => {
        checkBtn.disabled = true; checkBtn.innerHTML = '<span class="spinner"></span>';
        try {
          const refreshed = await load(true);
          if (refreshed.deposit.status !== 'pending') { toast('Deposit status updated'); await paint(false); }
          else { toast('The provider has not confirmed this payment yet', 'warn'); checkBtn.disabled = false; checkBtn.textContent = 'CHECK STATUS'; }
        } catch (e) {
          toast(e.message, 'error');
          checkBtn.disabled = false; checkBtn.textContent = 'CHECK STATUS';
        }
      });

      const simBtn = el('#sandbox-sim');
      if (simBtn) simBtn.addEventListener('click', async () => {
        simBtn.disabled = true; simBtn.innerHTML = '<span class="spinner"></span>';
        try {
          await API.post('/api/mpesa/sandbox/callback', { kind: 'deposit', txn_id: txnId, result: 'SUCCESS' });
          await paint(true);
          toast('Sandbox confirmation recorded (not a real M-Pesa payment)');
        } catch (e) {
          toast(e.message, 'error');
          simBtn.disabled = false; simBtn.textContent = 'SIMULATE SANDBOX CONFIRMATION';
        }
      });
    };

    await paint(false);

    // Poll while pending so the screen reflects genuine provider state.
    state.depPoll = setInterval(async () => {
      try {
        const before = out.deposit.status;
        const fresh = await load(true);
        if (fresh.deposit.status !== before) { out = fresh; await paint(false); }
        else out = fresh;
      } catch { /* keep polling quietly */ }
    }, 5000);
  }

  /* ── 11 — WITHDRAW ───────────────────────────────────── */
  routes.withdraw = async () => {
    const [summary, config] = await Promise.all([
      API.get('/api/wallet/summary'),
      API.get('/api/wallet/config'),
    ]);
    return `
      <div class="page">
        ${header({ back: true, title: 'Withdraw' })}
        <div class="balance-card" style="min-height:120px">
          <div>
            <div class="balance-card__label">AVAILABLE BALANCE</div>
            <div class="balance-card__value">${esc(money(summary.available, summary.currency_code))}</div>
          </div>
          ${Number(summary.pending) > 0 ? `<div class="balance-card__rows"><div>On hold<strong>${esc(money(summary.pending, summary.currency_code))}</strong></div></div>` : ''}
        </div>

        <div class="field" style="margin-top:18px;max-width:none">
          <label for="wd-amount">Withdrawal Amount</label>
          <div class="field__control">
            <input class="input" id="wd-amount" type="number" inputmode="decimal" placeholder="KES 0.00" />
          </div>
          <div class="field__error" data-error-for="amount"></div>
        </div>

        <div class="field" style="margin-top:14px;max-width:none">
          <label for="wd-phone">M-Pesa Phone Number</label>
          <div class="field__control">
            <input class="input" id="wd-phone" type="tel" inputmode="tel" placeholder="07XXXXXXXX"
              value="${esc(state.user && state.user.payout_phone_set ? '' : (state.user && state.user.phone) || '')}" />
          </div>
          <div class="field__error" data-error-for="phone"></div>
        </div>

        <div class="card" style="margin-top:16px">
          <div class="kv"><span>Minimum withdrawal</span><span>${esc(money(config.min_withdrawal, config.currency_code))}</span></div>
          <div class="kv"><span>Processing fee</span><span id="wd-fee">${esc(String(config.withdrawal_fee_pct))}%</span></div>
          <div class="kv"><span>Expected processing</span><span>${esc(config.expected_processing)}</span></div>
          <div class="kv"><span>You will receive</span><span id="wd-net">—</span></div>
        </div>

        <button class="btn btn-primary" id="wd-submit" style="margin-top:20px">REQUEST WITHDRAWAL</button>
        <p class="muted small" style="margin-top:12px">Your balance is held as soon as you request a withdrawal, and the payout is only marked completed after the payment provider confirms it.</p>
      </div>`;
  };

  routes.withdraw.wire = async () => {
    const amountInput = el('#wd-amount');
    const phoneInput = el('#wd-phone');
    const netLabel = el('#wd-net');
    const feeLabel = el('#wd-fee');
    const feePct = feeLabel.textContent;
    let quote = null;

    const refreshQuote = async () => {
      const amount = Number(amountInput.value);
      if (!(amount > 0)) {
        netLabel.textContent = '—';
        feeLabel.textContent = feePct;
        quote = null;
        return;
      }
      try {
        quote = await API.post('/api/wallet/withdraw/quote', { amount });
        netLabel.textContent = money(quote.net_amount, quote.currency_code);
        feeLabel.textContent = `${quote.fee_pct}% · ${money(quote.fee, quote.currency_code)}`;
      } catch {
        netLabel.textContent = '—';
        feeLabel.textContent = feePct;
        quote = null;
      }
    };
    amountInput.addEventListener('input', () => { clearTimeout(amountInput._t); amountInput._t = setTimeout(refreshQuote, 250); });

    el('#wd-submit').addEventListener('click', async () => {
      const amount = Number(amountInput.value);
      const phone = phoneInput.value.trim();
      const errAmount = el('[data-error-for="amount"]');
      const errPhone = el('[data-error-for="phone"]');
      errAmount.textContent = ''; errPhone.textContent = '';

      if (!(amount > 0)) { errAmount.textContent = 'Enter a withdrawal amount'; return; }
      if (!/^(07\d{8}|01\d{8}|2547\d{8}|2541\d{8})$/.test(phone.replace(/[^\d]/g, ''))) { errPhone.textContent = 'Enter a valid M-Pesa phone number'; return; }

      let q = quote;
      try { q = await API.post('/api/wallet/withdraw/quote', { amount }); } catch { /* fall back */ }
      if (q && !q.valid) { errAmount.textContent = (q.errors && q.errors[0]) || 'Invalid amount'; return; }

      openWithdrawConfirm({ amount, phone, quote: q, onDone: () => {
        amountInput.value = '';
        netLabel.textContent = '—';
        quote = null;
      } });
    });
  };

  /* ── 12 — WITHDRAWAL CONFIRMATION ────────────────────── */
  function openWithdrawConfirm({ amount, phone, quote, onDone }) {
    const fee = quote ? quote.fee : 0;
    const net = quote ? quote.net_amount : amount;
    const masked = `${phone.slice(0, 2)}******${phone.slice(-2)}`;
    const cc = (quote && quote.currency_code) || state.currency;
    const s = sheet(`
      <h2>Confirm Withdrawal</h2>
      <div class="sheet__rows">
        <div class="kv"><span>Amount</span><span>${esc(money(amount, cc))}</span></div>
        <div class="kv"><span>M-Pesa Number</span><span>${esc(masked)}</span></div>
        <div class="kv"><span>Fee</span><span>${esc(money(fee, cc))}</span></div>
        <div class="kv"><span>You will receive</span><span>${esc(money(net, cc))}</span></div>
      </div>
      <div class="sheet__actions">
        <button class="btn btn-ghost" data-close>CANCEL</button>
        <button class="btn btn-primary" id="wd-confirm">CONFIRM WITHDRAWAL</button>
      </div>`);

    el('#wd-confirm', s.node).addEventListener('click', async () => {
      const btn = el('#wd-confirm', s.node);
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
      try {
        const out = await API.post('/api/wallet/withdraw', { amount, phone, idempotency_key: uuid() });
        s.close();
        if (onDone) onDone();
        withdrawalSubmittedScreen(out);
      } catch (e) {
        toast(e.message, 'error');
        btn.disabled = false; btn.textContent = 'CONFIRM WITHDRAWAL';
      }
    });
  }

  function withdrawalSubmittedScreen(out) {
    const w = out.withdrawal;
    view.innerHTML = `
      <div class="page no-nav">
        ${header({ back: true, title: 'Withdraw' })}
        <div class="status">
          <div class="status__icon status__icon--warning">${I.clock}</div>
          <h1>Withdrawal Request Submitted</h1>
          <p>Your request is queued. The status stays Pending until the payment provider confirms the payout.</p>
          <div class="card">
            <div class="kv"><span>Request ID</span><span>${esc(w.request_id)}</span></div>
            <div class="kv"><span>Amount</span><span>${esc(money(w.amount, w.currency_code))}</span></div>
            <div class="kv"><span>Fee</span><span>${esc(money(w.fee, w.currency_code))}</span></div>
            <div class="kv"><span>You will receive</span><span>${esc(money(w.net_amount, w.currency_code))}</span></div>
            <div class="kv"><span>M-Pesa Number</span><span>${esc(w.destination)}</span></div>
            <div class="kv"><span>Status</span><span>Pending</span></div>
          </div>
          ${out.sandbox ? `<div class="notice notice--warning" style="margin-top:16px;text-align:left">Sandbox mode: no payout was sent to M-Pesa. This request stays Pending.</div>` : ''}
          <div class="row gap" style="margin-top:18px;width:100%">
            <button class="btn btn-ghost" data-href="#/transactions">View history</button>
            <button class="btn btn-primary" data-href="#/wallet">Back to wallet</button>
          </div>
        </div>
      </div>`;
    wireCommon();
    toast('Withdrawal request submitted — status: Pending');
  }

  /* ── 13 — TRANSACTION HISTORY ────────────────────────── */
  routes.transactions = async () => {
    state.txOffset = 0;
    state.txFilter = 'all';
    return `
      <div class="page">
        ${header({ back: true, title: 'Transaction History' })}
        <div class="tabs" id="tx-tabs">
          ${[['all', 'ALL'], ['deposits', 'DEPOSITS'], ['earnings', 'EARNINGS'], ['withdrawals', 'WITHDRAWALS']]
            .map(([k, label]) => `<button class="tab ${k === 'all' ? 'is-active' : ''}" data-filter="${k}">${label}</button>`).join('')}
        </div>
        <div id="tx-list">${loadingBlock(4)}</div>
      </div>
      ${bottomNav('transactions')}`;
  };

  routes.transactions.wire = () => {
    const list = el('#tx-list');

    const load = async (reset) => {
      if (state.txLoading) return;
      state.txLoading = true;
      if (reset) state.txOffset = 0;
      try {
        const out = await API.get(`/api/wallet/transactions?filter=${state.txFilter}&limit=20&offset=${state.txOffset}`);
        const rows = out.transactions.map(txnRow).join('');
        if (reset) list.innerHTML = rows;
        else list.insertAdjacentHTML('beforeend', rows);

        if (!out.transactions.length && reset) {
          list.innerHTML = emptyState({
            title: 'No Transactions Yet',
            message: 'Your completed deposits, rewards and withdrawals will appear here.',
            action: 'Start watching',
            href: '#/watch',
          });
          wireCommon();
        }
        state.txOffset += out.transactions.length;
        if (out.has_more && !el('#tx-more')) {
          list.insertAdjacentHTML('afterend', '<div id="tx-more" class="spin-center"><div class="spinner"></div></div>');
        } else if (!out.has_more) {
          const more = el('#tx-more');
          if (more) more.remove();
        }
      } catch (e) {
        list.innerHTML = errorState(e.message);
        wireCommon();
      } finally {
        state.txLoading = false;
      }
    };

    els('[data-filter]').forEach((b) => b.addEventListener('click', () => {
      els('[data-filter]').forEach((x) => x.classList.remove('is-active'));
      b.classList.add('is-active');
      state.txFilter = b.getAttribute('data-filter');
      const more = el('#tx-more');
      if (more) more.remove();
      list.innerHTML = loadingBlock(4);
      load(true);
    }));

    window.onscroll = () => {
      if (state.route !== 'transactions') return;
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 260) load(false);
    };

    load(true);
  };

  /* ── 14 — TEAM / REFERRAL ────────────────────────────── */
  routes.team = async () => {
    const out = await API.get('/api/team');
    return `
      <div class="page">
        ${header()}
        <div class="screen-head">
          <div class="screen-head__row">
            <button class="back" data-href="#/home" aria-label="Back">${I.back}</button>
            <h1>My Team</h1>
          </div>
        </div>

        <div class="card card--lg">
          <div class="card__title">YOUR REFERRAL CODE</div>
          <div class="code-box">
            <strong>${esc(out.code)}</strong>
            <button class="btn btn-sm btn-primary btn-auto" data-copy="${esc(out.code)}">${I.copy} COPY</button>
          </div>
          <div class="card__title" style="margin-top:18px">YOUR REFERRAL LINK</div>
          <div class="link-box">
            <span>${esc(out.link)}</span>
            <button class="btn btn-sm btn-primary btn-auto" data-share="${esc(out.link)}">${I.share} SHARE</button>
          </div>
        </div>

        <div class="stats-grid">
          <div class="stat">
            <div class="stat__label">Total Referrals</div>
            <div class="stat__value">${Number(out.stats.total_referrals) || 0}</div>
          </div>
          <div class="stat">
            <div class="stat__label">Active Referrals</div>
            <div class="stat__value">${Number(out.stats.active_referrals) || 0}</div>
          </div>
          <div class="stat" style="grid-column: span 2">
            <div class="stat__label">Referral Rewards</div>
            <div class="stat__value">${esc(money(out.stats.referral_rewards, out.currency_code))}</div>
          </div>
        </div>

        <div class="card" style="margin-top:18px">
          <div class="card__title">How referrals work</div>
          <ol class="rule-list">
            ${(out.reward_rules || []).map((r) => `<li>${esc(r)}</li>`).join('')}
          </ol>
        </div>

        <div class="card">
          <div class="card__title">Your referrals</div>
          ${out.members && out.members.length ? `
            <div style="margin-top:10px">
              ${out.members.map((m) => `
                <div class="txn">
                  <div class="txn__icon">${I.person}</div>
                  <div class="txn__body">
                    <div class="txn__desc">${esc(m.handle)}</div>
                    <div class="txn__date">Joined ${esc(dateShort(m.joined))}</div>
                  </div>
                  <div class="txn__right">
                    <div class="txn__amount in">${esc(money(m.commission, out.currency_code))}</div>
                    <div class="txn__status">${m.status === 'active' ? 'Active' : 'Pending condition'}</div>
                  </div>
                </div>`).join('')}
            </div>` : '<p class="muted small" style="margin-top:8px">No referrals yet. Share your link to build your team.</p>'}
        </div>
      </div>
      ${bottomNav('team')}`;
  };

  /* ── 15 — REWARDS ────────────────────────────────────── */
  routes.rewards = async () => {
    const out = await API.get('/api/watch/rewards');
    return `
      <div class="page">
        ${header({ back: true, title: 'Rewards' })}
        <div class="card card--lg" style="margin-top:6px">
          <div class="reward-card__head">
            <div>
              <div class="reward-card__title">${esc(out.daily_watch.title)}</div>
              <p class="muted small" style="margin-top:4px">Verified watch rewards credited to your wallet ledger.</p>
            </div>
            <div class="reward-card__value">${esc(out.daily_watch.label)}</div>
          </div>
          <button class="btn btn-primary btn-sm" style="margin-top:16px" data-href="#/watch">VIEW TASKS</button>
        </div>

        <div class="card card--lg">
          <div class="reward-card__head">
            <div>
              <div class="reward-card__title">${esc(out.referral.title)}</div>
              <p class="muted small" style="margin-top:4px">Status: ${esc(out.referral.status)}</p>
            </div>
            <div class="reward-card__value">${esc(money(out.referral.reward, out.currency_code))}</div>
          </div>
          <div class="kv" style="margin-top:10px"><span>Referrals</span><span>${Number(out.referral.referrals) || 0}</span></div>
          <div class="kv"><span>Earned so far</span><span>${esc(money(out.referral.earned, out.currency_code))}</span></div>
          <button class="btn btn-ghost btn-sm" style="margin-top:14px" data-href="#/team">VIEW TEAM</button>
        </div>

        <div class="card card--lg">
          <div class="reward-card__head">
            <div>
              <div class="reward-card__title">${esc(out.bonus.title)}</div>
              <p class="muted small" style="margin-top:4px">Status: ${esc(out.bonus.status)}</p>
            </div>
            <div class="reward-card__value">${esc(money(out.bonus.amount, out.currency_code))}</div>
          </div>
          <p class="muted small" style="margin-top:10px">Bonuses appear here when an operator publishes one. Deposits never generate guaranteed returns.</p>
        </div>
      </div>
      ${bottomNav('rewards')}`;
  };

  /* ── 16 — NOTIFICATIONS ──────────────────────────────── */
  routes.notifications = async () => {
    const out = await API.get('/api/notifications');
    return `
      <div class="page">
        ${header({ back: true, title: 'Notifications' })}
        ${out.notifications.length ? `
          <div class="card card--flat" style="padding:0;overflow:hidden;margin-top:8px">
            ${out.notifications.map((n) => `
              <div class="note" data-note="${n.id}" data-link="${esc(n.link || '')}">
                <span class="note__dot ${n.is_read ? 'read' : ''}"></span>
                <div class="note__body">
                  <div class="note__title">${esc(n.title)}</div>
                  <div class="note__msg">${esc(n.message)}</div>
                  <div class="note__time">${esc(timeAgo(n.created_at))}${n.is_read ? '' : ' · unread'}</div>
                </div>
              </div>`).join('')}
          </div>
          <button class="btn btn-ghost" id="notes-read" style="margin-top:16px">MARK ALL AS READ</button>
        ` : emptyState({
          title: 'No notifications yet',
          message: 'Deposit results, verified rewards and payout updates will show up here.',
          icon: I.bell,
        })}
      </div>
      ${bottomNav('notifications')}`;
  };

  routes.notifications.wire = () => {
    const readAll = el('#notes-read');
    if (readAll) readAll.addEventListener('click', async () => {
      await API.post('/api/notifications/read-all');
      toast('All notifications marked as read');
      render();
    });

    els('[data-note]').forEach((row) => row.addEventListener('click', async () => {
      const id = row.getAttribute('data-note');
      const link = row.getAttribute('data-link');
      const dot = row.querySelector('.note__dot');
      if (dot) dot.classList.add('read');
      try { await API.post(`/api/notifications/${id}/read`); } catch { /* non-blocking */ }
      if (link) go(link);
    }));
  };

  /* ── 17 — PROFILE ────────────────────────────────────── */
  routes.profile = async () => {
    const out = await API.get('/api/auth/profile');
    const u = out.user;
    state.user = { ...(state.user || {}), ...u };
    return `
      <div class="page">
        ${header()}
        <div class="screen-head"><h1 class="screen-title">Profile</h1></div>

        <div class="profile-head">
          <div class="avatar">${esc(initials(u.fullname))}</div>
          <div class="profile-head__name">${esc(u.fullname)}</div>
          <div class="profile-head__phone">${esc(u.phone)}</div>
        </div>

        <div class="menu">
          <button class="menu__row" data-href="#/profile/personal">${I.person}<span class="label">Personal Information</span><span class="chev">${I.chevron}</span></button>
          <button class="menu__row" data-href="#/profile/mpesa">${I.phone}<span class="label">M-Pesa Details</span><span class="chev">${I.chevron}</span></button>
          <button class="menu__row" data-href="#/profile/security">${I.shield}<span class="label">Security</span><span class="chev">${I.chevron}</span></button>
          <button class="menu__row" data-href="#/transactions">${I.list}<span class="label">Transaction History</span><span class="chev">${I.chevron}</span></button>
          <button class="menu__row" data-href="#/support">${I.help}<span class="label">Help &amp; Support</span><span class="chev">${I.chevron}</span></button>
          <button class="menu__row" data-href="#/terms">${I.doc}<span class="label">Terms &amp; Conditions</span><span class="chev">${I.chevron}</span></button>
          <button class="menu__row" data-href="#/privacy">${I.doc}<span class="label">Privacy Policy</span><span class="chev">${I.chevron}</span></button>
          <button class="menu__row danger" id="logout-row">${I.logout}<span class="label">Logout</span><span class="chev">${I.chevron}</span></button>
        </div>
      </div>
      ${bottomNav('profile')}`;
  };

  routes.profile.wire = () => {
    el('#logout-row').addEventListener('click', async () => {
      try { await API.post('/api/auth/logout'); } catch { /* ignore */ }
      state.user = null;
      toast('Signed out');
      go('#/login');
    });
  };

  /* ── 18 — PERSONAL INFORMATION ───────────────────────── */
  routes.personal = async () => {
    const out = await API.get('/api/auth/profile');
    const u = out.user;
    return `
      <div class="page no-nav">
        ${header({ back: true, title: 'Personal Information' })}
        <div class="card" style="margin-top:6px">
          <div class="field" style="max-width:none">
            <label for="pi-fullname">Full Name</label>
            <div class="field__control"><input class="input" id="pi-fullname" value="${esc(u.fullname)}" /></div>
            <div class="field__error" data-error-for="fullname"></div>
          </div>
          <div class="field" style="margin-top:14px;max-width:none">
            <label for="pi-phone">Phone Number</label>
            <div class="field__control"><input class="input" id="pi-phone" value="${esc(u.phone)}" inputmode="tel" /></div>
            <div class="field__hint">Changing your account phone number requires your account password.</div>
            <div class="field__error" data-error-for="phone"></div>
          </div>
          <div class="field" style="margin-top:14px;max-width:none">
            <label for="pi-email">Email</label>
            <div class="field__control"><input class="input" id="pi-email" value="${esc(u.email)}" inputmode="email" /></div>
            <div class="field__error" data-error-for="email"></div>
          </div>
          <div class="field hidden" id="pi-password-wrap" style="margin-top:14px;max-width:none">
            <label for="pi-password">Account Password (verification)</label>
            <div class="field__control">
              <input class="input" id="pi-password" type="password" placeholder="Enter your password" />
              <button class="field__eye" type="button" data-password-toggle aria-label="Show password">${I.eye}</button>
            </div>
            <div class="field__error" data-error-for="password"></div>
          </div>
          <button class="btn btn-primary" id="pi-save" style="margin-top:18px">SAVE CHANGES</button>
        </div>
      </div>`;
  };

  routes.personal.wire = () => {
    const phoneInput = el('#pi-phone');
    const pwWrap = el('#pi-password-wrap');
    const originalPhone = phoneInput.value;
    phoneInput.addEventListener('input', () => {
      pwWrap.classList.toggle('hidden', phoneInput.value.trim() === originalPhone);
    });

    el('#pi-save').addEventListener('click', async () => {
      const btn = el('#pi-save');
      const fullname = el('#pi-fullname').value.trim();
      const email = el('#pi-email').value.trim();
      const phone = phoneInput.value.trim();
      const password = el('#pi-password').value;
      ['fullname', 'email', 'phone', 'password'].forEach((f) => { const b = el(`[data-error-for="${f}"]`); if (b) b.textContent = ''; });

      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
      try {
        await API.put('/api/auth/profile', { fullname, email });
        if (phone !== originalPhone) {
          if (!password) {
            el('[data-error-for="password"]').textContent = 'Enter your account password to change your phone number';
            btn.disabled = false; btn.textContent = 'SAVE CHANGES';
            return;
          }
          await API.post('/api/auth/phone', { phone, password });
        }
        const fresh = await API.get('/api/auth/profile');
        state.user = { ...(state.user || {}), ...fresh.user };
        toast('Changes saved');
        go('#/profile');
      } catch (err) {
        const errs = (err.data && err.data.errors) || {};
        const keys = Object.keys(errs);
        if (keys.length) el(`[data-error-for="${keys[0]}"]`).textContent = errs[keys[0]];
        else el('[data-error-for="phone"]').textContent = err.message;
        btn.disabled = false; btn.textContent = 'SAVE CHANGES';
      }
    });
  };

  /* ── 19 — M-PESA DETAILS ─────────────────────────────── */
  routes.mpesa = async () => {
    const out = await API.get('/api/auth/payout');
    return `
      <div class="page no-nav">
        ${header({ back: true, title: 'M-Pesa Details' })}
        <div class="card" style="margin-top:6px">
          <div class="card__title">Registered payout number</div>
          <div class="code-box" style="letter-spacing:1px"><strong>${esc(out.payout_phone || 'Not set')}</strong></div>
          <p class="muted small" style="margin-top:12px">Withdrawals are sent to this number. Changing it requires your account password (${esc(out.verification_required)}).</p>

          <div class="field" style="margin-top:16px;max-width:none">
            <label for="mp-phone">New M-Pesa Number</label>
            <div class="field__control"><input class="input" id="mp-phone" inputmode="tel" placeholder="07XXXXXXXX" /></div>
            <div class="field__error" data-error-for="phone"></div>
          </div>
          <div class="field" style="margin-top:14px;max-width:none">
            <label for="mp-password">Account Password</label>
            <div class="field__control">
              <input class="input" id="mp-password" type="password" placeholder="Enter your password" />
              <button class="field__eye" type="button" data-password-toggle aria-label="Show password">${I.eye}</button>
            </div>
            <div class="field__error" data-error-for="password"></div>
          </div>
          <button class="btn btn-primary" id="mp-save" style="margin-top:18px">UPDATE NUMBER</button>
        </div>
      </div>`;
  };

  routes.mpesa.wire = () => {
    el('#mp-save').addEventListener('click', async () => {
      const phone = el('#mp-phone').value.trim();
      const password = el('#mp-password').value;
      const btn = el('#mp-save');
      el('[data-error-for="phone"]').textContent = '';
      el('[data-error-for="password"]').textContent = '';
      if (!phone) { el('[data-error-for="phone"]').textContent = 'Enter the new M-Pesa number'; return; }
      if (!password) { el('[data-error-for="password"]').textContent = 'Enter your account password'; return; }
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
      try {
        const out = await API.post('/api/auth/payout', { phone, password });
        toast(out.message || 'M-Pesa details updated');
        go('#/profile');
      } catch (err) {
        const errs = (err.data && err.data.errors) || {};
        const keys = Object.keys(errs);
        if (keys.length) el(`[data-error-for="${keys[0]}"]`).textContent = errs[keys[0]];
        else el('[data-error-for="password"]').textContent = err.message;
        btn.disabled = false; btn.textContent = 'UPDATE NUMBER';
      }
    });
  };

  /* ── 20 — SECURITY ───────────────────────────────────── */
  routes.security = async () => {
    const out = await API.get('/api/auth/sessions');
    return `
      <div class="page no-nav">
        ${header({ back: true, title: 'Security' })}
        <div class="card" style="margin-top:6px">
          <div class="card__title">Change Password</div>
          <div class="field" style="margin-top:12px;max-width:none">
            <label for="sec-current">Current Password</label>
            <div class="field__control">
              <input class="input" id="sec-current" type="password" placeholder="Current password" />
              <button class="field__eye" type="button" data-password-toggle aria-label="Show password">${I.eye}</button>
            </div>
          </div>
          <div class="field" style="margin-top:12px;max-width:none">
            <label for="sec-new">New Password</label>
            <div class="field__control"><input class="input" id="sec-new" type="password" placeholder="8+ characters, letters and numbers" /></div>
          </div>
          <div class="field" style="margin-top:12px;max-width:none">
            <label for="sec-confirm">Confirm New Password</label>
            <div class="field__control"><input class="input" id="sec-confirm" type="password" placeholder="Re-enter new password" /></div>
          </div>
          <div class="field__error" data-error-for="password"></div>
          <button class="btn btn-primary" id="sec-save" style="margin-top:16px">CHANGE PASSWORD</button>
          <p class="muted small" style="margin-top:10px">This platform signs you in with a password; there is no separate transaction PIN.</p>
        </div>

        <div class="card">
          <div class="card__title">Login Sessions</div>
          <div style="margin-top:8px">
            ${out.sessions.map((s) => `
              <div class="kv">
                <span>${esc(s.device)}<br><span class="small">${esc(dateTime(s.last_seen_at))}</span></span>
                <span>${s.revoked ? 'Revoked' : s.current ? 'This device' : 'Active'}</span>
              </div>`).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card__title">Logout All Devices</div>
          <p class="muted small" style="margin-top:8px">Ends every session on every device, including this one. You will need to sign in again.</p>
          <button class="btn btn-ghost" id="sec-logout-all" style="margin-top:14px">LOGOUT ALL DEVICES</button>
        </div>
      </div>`;
  };

  routes.security.wire = () => {
    el('#sec-save').addEventListener('click', async () => {
      const current = el('#sec-current').value;
      const next = el('#sec-new').value;
      const confirm = el('#sec-confirm').value;
      const errBox = el('[data-error-for="password"]');
      errBox.textContent = '';
      if (!(next.length >= 8 && /[a-zA-Z]/.test(next) && /\d/.test(next))) { errBox.textContent = 'New password needs 8+ characters with letters and numbers'; return; }
      if (next !== confirm) { errBox.textContent = 'Passwords do not match'; return; }
      const btn = el('#sec-save');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
      try {
        await API.post('/api/auth/change-password', { current_password: current, new_password: next, confirm_password: confirm });
        toast('Password changed');
        go('#/profile/security');
      } catch (err) {
        errBox.textContent = err.message;
        btn.disabled = false; btn.textContent = 'CHANGE PASSWORD';
      }
    });

    el('#sec-logout-all').addEventListener('click', async () => {
      const s = sheet(`
        <h2>Logout All Devices</h2>
        <p class="muted center" style="margin-top:10px">Every session will end and you will be signed out of this device too.</p>
        <div class="sheet__actions">
          <button class="btn btn-ghost" data-close>Cancel</button>
          <button class="btn btn-primary" id="all-yes">LOGOUT ALL</button>
        </div>`);
      el('#all-yes', s.node).addEventListener('click', async () => {
        try { await API.post('/api/auth/logout-all'); } catch { /* ignore */ }
        s.close();
        state.user = null;
        toast('Signed out of all devices');
        go('#/login');
      });
    });
  };

  /* ── Supporting documents ────────────────────────────── */
  routes.support = async () => `
    <div class="page no-nav">
      ${header({ back: true, title: 'Help & Support' })}
      <div class="card" style="margin-top:6px">
        <div class="card__title">We are here to help</div>
        <p class="muted small" style="margin-top:8px">Questions about a deposit, a watch reward or a payout? Contact support with your transaction reference and we will trace it against the ledger.</p>
        <div class="kv" style="margin-top:10px"><span>Support email</span><span>${esc((state.config && state.config.support_email) || 'support@watchrewards.app')}</span></div>
        <div class="kv"><span>Response time</span><span>Within 24 hours</span></div>
        <a class="btn btn-primary" style="margin-top:16px" href="mailto:${esc((state.config && state.config.support_email) || 'support@watchrewards.app')}">EMAIL SUPPORT</a>
      </div>
      <div class="card">
        <div class="card__title">Payments</div>
        <p class="muted small" style="margin-top:8px">Deposits and withdrawals are processed through M-Pesa. A deposit is only credited after the payment provider confirms it, and a payout only completes after the provider confirms the transfer.</p>
      </div>
    </div>`;

  routes.terms = async () => `
    <div class="page no-nav">
      ${header({ back: true, title: 'Terms & Conditions' })}
      <div class="card" style="margin-top:6px">
        <p class="small muted">WATCHREWARDS — Terms &amp; Conditions (summary)</p>
        <ol class="rule-list" style="margin-top:12px">
          <li>WATCHREWARDS is a rewards platform. Rewards are earned only by completing eligible watch tasks and by meeting the published referral conditions.</li>
          <li>Watching is verified server-side. A reward is credited only for a session that meets the required watch duration and daily limits.</li>
          <li>Deposits are funds you add to your wallet. They do not generate profit, interest or guaranteed returns of any kind.</li>
          <li>Withdrawals are paid to your M-Pesa number after the payment provider confirms the transfer. A pending request is not a completed payout.</li>
          <li>One account per person and per phone number. Accounts created to abuse rewards may be suspended.</li>
          <li>You are responsible for the accuracy of your payout details and for any tax obligations that apply to you.</li>
        </ol>
      </div>
    </div>`;

  routes.privacy = async () => `
    <div class="page no-nav">
      ${header({ back: true, title: 'Privacy Policy' })}
      <div class="card" style="margin-top:6px">
        <p class="small muted">WATCHREWARDS — Privacy Policy (summary)</p>
        <ol class="rule-list" style="margin-top:12px">
          <li>We collect the details you provide at registration: name, phone number, email and your M-Pesa payout number.</li>
          <li>Passwords are stored only as bcrypt hashes. Payment provider credentials live on the server and are never sent to your device.</li>
          <li>Watch sessions record the video, duration and progress needed to verify a reward, plus technical details used to prevent abuse.</li>
          <li>Your phone number is masked on screens where it is displayed, and other users can never see your balance or transactions.</li>
          <li>We do not sell your personal data. Financial records are kept for accounting and dispute resolution.</li>
          <li>You can ask us to correct your details or close your account by contacting support.</li>
        </ol>
      </div>
    </div>`;

  /* ── route aliases for sub-screens ───────────────────── */
  const combinedRoutes = {};
  for (const [key, fn] of Object.entries(routes)) combinedRoutes[key] = fn;

  const router = {
    async handle() {
      // Stop anything the previous screen was running.
      if (state.depPoll) { clearInterval(state.depPoll); state.depPoll = null; }
      if (state.player && state.player.stop) { state.player.stop(); state.player = null; }

      const { segments, params } = parse();
      const key = segments[0] || 'home';
      state.route = key;

      // The player is a sub-route of the task list: #/watch/:videoId
      if (key === 'watch' && segments[1]) {
        return renderScreen(routes.player, { params, id: segments[1] });
      }

      // Sub-routes of the profile section
      if (key === 'profile' && segments[1]) {
        const sub = segments[1];
        if (sub === 'personal') return renderScreen(routes.personal, { params });
        if (sub === 'mpesa') return renderScreen(routes.mpesa, { params });
        if (sub === 'security') return renderScreen(routes.security, { params });
      }
      // Deposit status by reference
      if (key === 'deposit' && segments[1]) {
        return renderDepositStatus(segments[1], params.sandbox === '1');
      }
      // Withdrawal status by request id
      if (key === 'withdrawals' && segments[1]) {
        return renderWithdrawalStatus(segments[1]);
      }
      if (!combinedRoutes[key]) return renderScreen(null, { params });
      return renderScreen(combinedRoutes[key], { params });
    },
  };

  async function renderScreen(screen, { params, id = '' }) {
    if (!screen) {
      view.innerHTML = `<div class="page no-nav">${header({ back: true, title: 'Not found' })}
        ${emptyState({ title: 'Page not found', message: 'That screen does not exist. Head back to your dashboard.', action: 'Go home', href: '#/home' })}
      </div>`;
      wireCommon();
      return;
    }
    try {
      const html = await screen({ sub: '', id, params });
      view.innerHTML = html;
      wireCommon();
      if (screen.wire) await screen.wire({ sub: '', id, params });
    } catch (e) {
      view.innerHTML = `<div class="page no-nav">${header({ back: true, title: 'WATCHREWARDS' })}<div style="margin-top:18px">${errorState(e.message)}</div></div>`;
      wireCommon();
    }
    window.scrollTo({ top: 0 });
  }

  async function renderDepositStatus(txnId, sandboxFlag) {
    try {
      await depositStatusScreen(txnId, sandboxFlag);
    } catch (e) {
      view.innerHTML = `<div class="page no-nav">${header({ back: true, title: 'Deposit via M-Pesa' })}<div style="margin-top:18px">${errorState(e.message)}</div></div>`;
      wireCommon();
    }
    window.scrollTo({ top: 0 });
  }

  async function renderWithdrawalStatus(requestId) {
    try {
      const out = await API.get(`/api/wallet/withdrawals/${encodeURIComponent(requestId)}`);
      const w = out.withdrawal;
      view.innerHTML = `
        <div class="page no-nav">
          ${header({ back: true, title: 'Withdraw' })}
          <div class="status">
            <div class="status__icon ${w.status === 'completed' ? 'status__icon--success' : w.status === 'failed' ? 'status__icon--danger' : 'status__icon--warning'}">
              ${w.status === 'completed' ? I.check : w.status === 'failed' ? I.alert : I.clock}
            </div>
            <h1>${w.status === 'completed' ? 'Withdrawal Completed' : w.status === 'failed' ? 'Withdrawal Failed' : 'Withdrawal Pending'}</h1>
            <p>${w.status === 'completed'
              ? `${esc(money(w.net_amount, w.currency_code))} was sent to your M-Pesa number.`
              : w.status === 'failed'
                ? `${esc(w.failure_reason || 'The payout could not be confirmed.')}`
                : 'Your payout is still being processed by the payment provider.'}</p>
            <div class="card">
              <div class="kv"><span>Request ID</span><span>${esc(w.request_id)}</span></div>
              <div class="kv"><span>Amount</span><span>${esc(money(w.amount, w.currency_code))}</span></div>
              <div class="kv"><span>Fee</span><span>${esc(money(w.fee, w.currency_code))}</span></div>
              <div class="kv"><span>You will receive</span><span>${esc(money(w.net_amount, w.currency_code))}</span></div>
              <div class="kv"><span>M-Pesa Number</span><span>${esc(w.destination)}</span></div>
              <div class="kv"><span>Status</span><span>${esc(w.status_label)}</span></div>
              ${w.receipt ? `<div class="kv"><span>Receipt</span><span>${esc(w.receipt)}</span></div>` : ''}
            </div>
            <div class="row gap" style="margin-top:18px;width:100%">
              <button class="btn btn-ghost" data-href="#/transactions">History</button>
              <button class="btn btn-primary" data-href="#/wallet">Back to wallet</button>
            </div>
          </div>
        </div>`;
      wireCommon();
    } catch (e) {
      view.innerHTML = `<div class="page no-nav">${header({ back: true, title: 'Withdraw' })}<div style="margin-top:18px">${errorState(e.message)}</div></div>`;
      wireCommon();
    }
  }

  /* ── boot ────────────────────────────────────────────── */
  async function boot() {
    const splash = document.getElementById('splash');
    const started = Date.now();

    // Public settings (provider mode, limits) are needed before any screen.
    try {
      state.config = await API.get('/api/public/config');
      state.currency = state.config.currency_code || 'KES';
    } catch { state.config = null; }

    // Existing session?
    if (location.hash.startsWith('#/reset-password')) {
      state.user = null;
    } else {
      try {
        const me = await API.get('/api/auth/me');
        state.user = me.user;
        state.currency = me.user.currency_code || state.currency;
        if (!location.hash || location.hash === '#/' || location.hash === '#/login') location.hash = '#/home';
      } catch { state.user = null; }
    }

    await new Promise((r) => setTimeout(r, Math.max(0, 1400 - (Date.now() - started))));

    if (splash) {
      splash.style.transition = 'opacity 220ms ease';
      splash.style.opacity = '0';
      setTimeout(() => splash.remove(), 240);
    }

    const requiresAuth = () => !['login', 'register', 'forgot', 'reset-password'].includes((parse().segments[0] || 'home'));
    if (requiresAuth() && !state.user) {
      location.hash = '#/login';
      await waitForHash();
    }

    await router.handle();
  }

  function waitForHash() {
    return new Promise((resolve) => {
      if (location.hash) return resolve();
      window.addEventListener('hashchange', () => resolve(), { once: true });
    });
  }

  window.addEventListener('hashchange', () => router.handle());
  window.addEventListener('online', () => toast('Back online'));
  window.addEventListener('offline', () => toast('You are offline — some data may be stale', 'warn'));
  boot();
})();
