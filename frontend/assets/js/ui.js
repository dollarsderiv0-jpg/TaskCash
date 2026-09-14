/** TaskCash shared UI: theme, toasts, modals, formatting, WS notifications, auth guard. */

const UI = {
  // ── Theme ──
  initTheme() {
    const saved = localStorage.getItem('tc_theme');
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    this.setTheme(saved || (prefersLight ? 'light' : 'dark'), false);
  },
  setTheme(theme, persist = true) {
    document.documentElement.setAttribute('data-theme', theme);
    if (persist) localStorage.setItem('tc_theme', theme);
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => { b.textContent = theme === 'dark' ? '☀️' : '🌙'; });
  },
  toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme');
    this.setTheme(cur === 'dark' ? 'light' : 'dark');
  },

  // ── Formatting ──
  kes(n, opts = {}) {
    const v = Number(n) || 0;
    return 'KES ' + v.toLocaleString('en-KE', { minimumFractionDigits: opts.decimals ?? 2, maximumFractionDigits: opts.decimals ?? 2 });
  },
  kes0(n) { return this.kes(n, { decimals: 0 }); },
  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },
  timeAgo(date) {
    const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return new Date(date).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
  },

  // ── Toasts ──
  toast(msg, type = 'success', ms = 3800) {
    let host = document.getElementById('toasts');
    if (!host) { host = document.createElement('div'); host.id = 'toasts'; document.body.appendChild(host); }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
  },

  // ── Modal ──
  modal(html) {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `<div class="modal">${html}</div>`;
    back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
    return back;
  },
  confirm(message) {
    return new Promise((resolve) => {
      const m = this.modal(`
        <h3>Confirm</h3><p class="muted">${message}</p>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
          <button class="btn btn-ghost" data-x>Cancel</button>
          <button class="btn btn-primary" data-ok>Confirm</button>
        </div>`);
      m.querySelector('[data-x]').onclick = () => { m.remove(); resolve(false); };
      m.querySelector('[data-ok]').onclick = () => { m.remove(); resolve(true); };
    });
  },

  // ── Count-up animation ──
  countUp(el, target, { prefix = 'KES ', decimals = 2, duration = 1200 } = {}) {
    const start = 0; const t0 = performance.now();
    function frame(t) {
      const p = Math.min((t - t0) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      const val = start + (target - start) * eased;
      el.textContent = prefix + val.toLocaleString('en-KE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  },

  // ── Copy helper ──
  async copy(text) {
    try { await navigator.clipboard.writeText(text); this.toast('Copied to clipboard'); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); this.toast('Copied to clipboard');
    }
  },

  // ── Auth guard ──
  requireLogin() {
    const u = window.API && API.user();
    if (!u) { location.href = '/login.html'; return null; }
    return u;
  },
  requireAdmin() {
    const u = this.requireLogin();
    if (u && u.role !== 'admin') { location.href = '/dashboard.html'; return null; }
    return u;
  },

  // ── Navbar helpers ──
  initNav() {
    const burger = document.querySelector('.nav-burger');
    const links = document.querySelector('.nav-links');
    if (burger && links) burger.addEventListener('click', () => links.classList.toggle('open'));
    const here = location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav-links a').forEach((a) => {
      const href = a.getAttribute('href');
      if (href === here || (here === '' && href === 'index.html')) a.classList.add('active');
    });
    this.initTheme();
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
      b.addEventListener('click', () => this.toggleTheme());
    });
  },

  // ── WebSocket live notifications ──
  connectSocket() {
    const u = API.user();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const tok = localStorage.getItem('tc_token') || '';
    const sock = new WebSocket(`${proto}://${location.host}/ws${tok ? `?token=${tok}` : ''}`);
    sock.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'notification') {
          const n = msg.payload;
          this.toast(`${n.title} — ${n.message}`, n.type === 'danger' ? 'error' : n.type === 'warning' ? 'warn' : 'success', 5200);
          document.dispatchEvent(new CustomEvent('tc:notification', { detail: n }));
        } else if (msg.type === 'feed') {
          document.dispatchEvent(new CustomEvent('tc:feed', { detail: msg.payload }));
        } else if (msg.type === 'chat') {
          document.dispatchEvent(new CustomEvent('tc:chat', { detail: msg.payload }));
        } else if (msg.type === 'announcement') {
          this.toast(`📣 ${msg.payload.title}`, 'success', 6000);
        } else if (msg.type === 'admin_alert') {
          document.dispatchEvent(new CustomEvent('tc:admin_alert', { detail: msg.payload }));
        }
      } catch { /* ignore */ }
    });
    window._tcSock = sock;
    return sock;
  },

  // ── Page scaffold helpers ──
  el(id) { return document.getElementById(id); },
};

window.UI = UI;
UI.initNav();
