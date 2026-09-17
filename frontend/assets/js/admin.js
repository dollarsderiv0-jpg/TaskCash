/* ============================================================================
   WATCHREWARDS — admin console (sections 21 – 24)
   Read-only view of platform money. Payout and deposit status changes are only
   ever produced by the payment provider result, never by an operator click.
   ========================================================================== */
(() => {
  'use strict';

  const root = document.getElementById('admin-root');
  const toastHost = document.getElementById('admin-toasts');
  const modalHost = document.getElementById('admin-modal');

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const el = (sel, scope = document) => scope.querySelector(sel);
  const els = (sel, scope = document) => [...scope.querySelectorAll(sel)];
  const money = (n, cc = 'KES') => `${cc} ${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const clock = (s) => `${String(Math.floor((Number(s) || 0) / 60)).padStart(2, '0')}:${String(Math.round(Number(s) || 0) % 60).padStart(2, '0')}`;
  const dateTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  };
  const cookie = (name) => {
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : '';
  };

  const state = { admin: null, section: 'dashboard', q: '', provider: null };

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

  const API = {
    async request(path, { method = 'GET', body, retry = true } = {}) {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const csrf = cookie('wr_csrf');
      if (csrf) headers['x-csrf-token'] = csrf;
      const res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (res.status === 403 && retry && /CSRF/i.test((data && data.error) || '')) {
        await fetch('/api/public/config', { credentials: 'same-origin' });
        return this.request(path, { method, body, retry: false });
      }
      if (!res.ok) {
        const err = new Error((data && data.error) || `Request failed (${res.status})`);
        err.status = res.status;
        err.data = data || {};
        throw err;
      }
      return data;
    },
    get: (p) => API.request(p),
    post: (p, b) => API.request(p, { method: 'POST', body: b || {} }),
    put: (p, b) => API.request(p, { method: 'PUT', body: b || {} }),
    del: (p) => API.request(p, { method: 'DELETE' }),
  };

  const ICON = {
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.4 6-5.4s6 2.1 6 5.4"/><path d="M16 8.4a3 3 0 0 1 0 5.6"/></svg>',
    videos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2.5" y="4.5" width="19" height="15" rx="3"/><path d="M10 9.2l5 2.8-5 2.8z" fill="currentColor" stroke="none"/></svg>',
    deposits: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>',
    withdrawals: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 20V8"/><path d="M7 13l5-5 5 5"/><path d="M4 4h16"/></svg>',
    rewards: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M3 12h18"/><path d="M12 8v12"/></svg>',
    referrals: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="7" r="3"/><circle cx="17" cy="17" r="3"/><path d="M9.5 9.5l5 5"/></svg>',
    notifications: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 15.5V11a6 6 0 1 0-12 0v4.5L4.5 18h15z"/><path d="M10 21h4"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/></svg>',
    audit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>',
  };

  const SECTIONS = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'users', label: 'Users' },
    { id: 'videos', label: 'Videos' },
    { id: 'deposits', label: 'Deposits' },
    { id: 'withdrawals', label: 'Withdrawals' },
    { id: 'rewards', label: 'Rewards' },
    { id: 'referrals', label: 'Referrals' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'settings', label: 'Settings' },
    { id: 'audit', label: 'Audit Logs' },
  ];

  /* ── login gate ──────────────────────────────────────── */
  function renderGate(message) {
    root.innerHTML = `
      <div class="gate">
        <div class="gate__card">
          <div class="gate__brand">WATCHREWARDS</div>
          <h1>Admin Console</h1>
          <p>Sign in with an administrator account to continue.</p>
          ${message ? `<div class="banner banner--danger" style="margin-top:16px">${esc(message)}</div>` : ''}
          <div class="a-field">
            <label for="gate-id">Admin Phone or Email</label>
            <input id="gate-id" placeholder="07XXXXXXXX" autocomplete="username" />
          </div>
          <div class="a-field">
            <label for="gate-pass">Password</label>
            <input id="gate-pass" type="password" placeholder="Password" autocomplete="current-password" />
          </div>
          <div class="a-field__error" id="gate-error"></div>
          <button class="a-btn a-btn--primary" id="gate-submit">SIGN IN</button>
          <p style="margin-top:16px"><a href="/">← Back to the app</a></p>
        </div>
      </div>`;

    el('#gate-submit').addEventListener('click', async () => {
      const phone = el('#gate-id').value.trim();
      const password = el('#gate-pass').value;
      const err = el('#gate-error');
      err.textContent = '';
      if (!phone || !password) { err.textContent = 'Enter your credentials'; return; }
      const btn = el('#gate-submit');
      btn.disabled = true; btn.textContent = 'SIGNING IN…';
      try {
        const out = await API.post('/api/auth/login', { phone, password });
        if (!out.user || out.user.role !== 'admin') {
          await API.post('/api/auth/logout').catch(() => {});
          renderGate('That account does not have admin access.');
          return;
        }
        state.admin = out.user;
        boot();
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false; btn.textContent = 'SIGN IN';
      }
    });
  }

  /* ── layout ──────────────────────────────────────────── */
  const shell = (title, subtitle, body, actions = '') => `
    <div class="layout">
      <aside class="sidebar">
        <div class="sidebar__brand">WATCHREWARDS</div>
        <div class="sidebar__sub">ADMIN CONSOLE</div>
        <nav class="sidebar__nav">
          ${SECTIONS.map((s) => `
            <button class="sidebar__item ${state.section === s.id ? 'is-active' : ''}" data-section="${s.id}">
              ${ICON[s.id]}<span>${s.label}</span>
            </button>`).join('')}
        </nav>
        <div class="sidebar__foot">
          Payment provider<br>
          <strong>${esc((state.provider && state.provider.label) || 'Unknown')}</strong><br>
          mode: <strong>${esc((state.provider && state.provider.mode) || '—')}</strong>
          ${state.provider && state.provider.sandbox ? '<br><span style="color:#F59E0B">Sandbox — no real M-Pesa movements</span>' : ''}
        </div>
      </aside>
      <main class="main">
        <div class="main__head">
          <div>
            <h1>${esc(title)}</h1>
            <p>${esc(subtitle)}</p>
          </div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            ${actions}
            <div class="admin-user">
              <span class="admin-user__avatar">${esc((state.admin.fullname || 'AD').split(' ').map((p) => p[0]).slice(0, 2).join(''))}</span>
              <span>${esc(state.admin.fullname || 'Administrator')}</span>
              <button class="a-btn a-btn--sm" id="admin-logout">Logout</button>
            </div>
          </div>
        </div>
        <div id="admin-body">${body}</div>
      </main>
    </div>`;

  function paint(title, subtitle, body, actions) {
    root.innerHTML = shell(title, subtitle, body, actions);
    els('[data-section]').forEach((b) => b.addEventListener('click', () => {
      state.section = b.getAttribute('data-section');
      renderSection();
    }));
    const logout = el('#admin-logout');
    if (logout) logout.addEventListener('click', async () => {
      await API.post('/api/auth/logout').catch(() => {});
      state.admin = null;
      renderGate();
    });
  }

  const loading = '<div class="admin-loading"><div class="spinner"></div></div>';
  const empty = (title, message) => `<div class="admin-empty"><strong>${esc(title)}</strong>${esc(message)}</div>`;

  const statusPill = (status) => {
    const s = String(status || '').toLowerCase();
    const cls = ['successful', 'success', 'completed'].includes(s) ? 'pill--success'
      : ['failed', 'rejected'].includes(s) ? 'pill--danger'
        : ['pending', 'processing'].includes(s) ? 'pill--warning'
          : s === 'active' ? 'pill--primary' : '';
    return `<span class="pill ${cls}">${esc(status)}</span>`;
  };

  /* ── sections ────────────────────────────────────────── */
  async function renderSection() {
    switch (state.section) {
      case 'users': return renderUsers();
      case 'videos': return renderVideos();
      case 'deposits': return renderDeposits();
      case 'withdrawals': return renderWithdrawals();
      case 'rewards': return renderRewards();
      case 'referrals': return renderReferrals();
      case 'notifications': return renderNotifications();
      case 'settings': return renderSettings();
      case 'audit': return renderAudit();
      default: return renderDashboard();
    }
  }

  async function renderDashboard() {
    paint('Dashboard', 'Live platform figures, read directly from the database.', loading);
    try {
      const out = await API.get('/api/admin/overview');
      state.provider = out.payment_provider;
      const cardFor = (key) => out.cards.find((c) => c.key === key) || { value: 0 };
      const value = (c) => (c.kind === 'money' ? money(c.value, out.currency_code) : Number(c.value).toLocaleString('en-US'));
      paint('Dashboard', 'Live platform figures, read directly from the database.', `
        <div class="banner${out.payment_provider.sandbox ? ' banner--warning' : ''}">
          Payment provider: <strong>${esc(out.payment_provider.label)}</strong> (${esc(out.payment_provider.mode)}).
          ${out.payment_provider.sandbox
            ? ' Sandbox mode — deposits and payouts are not sent to real M-Pesa and no real money moves.'
            : ' Live credentials are configured; every status change comes from the provider.'}
        </div>
        <div class="cards">
          ${out.cards.map((c) => `
            <div class="metric">
              <div class="metric__label">${esc(c.label)}</div>
              <div class="metric__value">${esc(value(c))}</div>
            </div>`).join('')}
        </div>
        <div class="panel">
          <div class="panel__head">
            <div>
              <h2>Platform activity</h2>
              <p>Derived from watch sessions, videos and the wallet ledger.</p>
            </div>
          </div>
          <div class="cards">
            <div class="metric"><div class="metric__label">Completed watches</div><div class="metric__value">${Number(out.extra.completed_watches).toLocaleString('en-US')}</div><div class="metric__foot">${Number(out.extra.verified_watch_seconds).toLocaleString('en-US')} verified watch seconds</div></div>
            <div class="metric"><div class="metric__label">Active videos</div><div class="metric__value">${Number(out.extra.active_videos).toLocaleString('en-US')}</div></div>
            <div class="metric"><div class="metric__label">Reward entries</div><div class="metric__value">${Number(out.extra.watch_reward_entries).toLocaleString('en-US')}</div></div>
            <div class="metric"><div class="metric__label">Suspended accounts</div><div class="metric__value">${Number(out.extra.suspended_users).toLocaleString('en-US')}</div></div>
          </div>
        </div>`);
    } catch (e) {
      paint('Dashboard', 'Live platform figures, read directly from the database.', `<div class="admin-empty"><strong>Could not load the dashboard</strong>${esc(e.message)}</div>`);
    }
  }

  const searchBox = () => `<input class="a-btn" id="user-search" placeholder="Search name, phone or email" value="${esc(state.q)}" style="text-align:left;min-width:240px" />`;
  const bindSearch = () => {
    const box = el('#user-search');
    if (box) box.addEventListener('change', () => { state.q = box.value; renderUsers(); });
  };

  async function renderUsers() {
    paint('Users', 'Registered accounts, balances and status.', loading, searchBox());
    bindSearch();

    try {
      const out = await API.get(`/api/admin/users${state.q ? `?q=${encodeURIComponent(state.q)}` : ''}`);
      const body = out.users.length ? `
        <div class="panel">
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>User</th><th>Phone</th><th>Balance</th><th>Watched</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead>
              <tbody>
                ${out.users.map((u) => `
                  <tr>
                    <td><strong>${esc(u.fullname)}</strong><br><span class="mono" style="color:var(--text-2)">${esc(u.email)}</span></td>
                    <td class="mono">${esc(u.phone)}</td>
                    <td>${esc(money(u.balance))}</td>
                    <td>${Number(u.watched_count) || 0}</td>
                    <td>${statusPill(u.status)}</td>
                    <td class="mono">${esc(dateTime(u.created_at))}</td>
                    <td class="actions">
                      <button class="a-btn a-btn--sm" data-suspend="${u.id}" data-status="${esc(u.status)}">${u.status === 'suspended' ? 'Reinstate' : 'Suspend'}</button>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>` : empty('No users found', 'Try a different search term.');

      paint('Users', 'Registered accounts, balances and status.', body, searchBox());
      bindSearch();

      els('[data-suspend]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.getAttribute('data-suspend');
        const isSuspended = b.getAttribute('data-status') === 'suspended';
        b.disabled = true;
        try {
          await API.post(`/api/admin/users/${id}/suspend`);
          toast(`User ${isSuspended ? 'reinstated' : 'suspended'}`);
          renderUsers();
        } catch (e) {
          toast(e.message, 'error');
          b.disabled = false;
        }
      }));
    } catch (e) {
      paint('Users', '', `<div class="admin-empty"><strong>Could not load users</strong>${esc(e.message)}</div>`);
    }
  }

  async function renderVideos() {
    paint('Videos', 'Manage the Watch & Earn library.', loading,
      '<button class="a-btn a-btn--primary" id="add-video">ADD VIDEO</button>');
    el('#add-video').addEventListener('click', () => openVideoForm(null));

    const addBtn = '<button class="a-btn a-btn--primary" id="add-video">ADD VIDEO</button>';
    try {
      const out = await API.get('/api/admin/videos');
      const body = out.videos.length ? `
        <div class="panel">
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Title</th><th>Duration</th><th>Reward</th><th>Daily limit</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                ${out.videos.map((v) => `
                  <tr>
                    <td><strong>${esc(v.title)}</strong><br><span class="mono" style="color:var(--text-2)">${esc(v.video_url)}</span></td>
                    <td class="mono">${esc(clock(v.duration_seconds))}</td>
                    <td>${esc(money(v.reward, v.currency_code))}</td>
                    <td>${Number(v.daily_limit)}</td>
                    <td>${statusPill(v.status)}</td>
                    <td class="actions">
                      <button class="a-btn a-btn--sm" data-edit="${v.id}">EDIT</button>
                      <button class="a-btn a-btn--sm" data-toggle="${v.id}" data-status="${esc(v.status)}">${v.status === 'active' ? 'DISABLE' : 'ENABLE'}</button>
                      <button class="a-btn a-btn--sm a-btn--danger" data-delete="${v.id}">DELETE</button>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>` : empty('No videos yet', 'Add the first Watch & Earn video to get started.');

      paint('Videos', 'Manage the Watch & Earn library.', body, addBtn);
      el('#add-video').addEventListener('click', () => openVideoForm(null));
      els('[data-edit]').forEach((b) => b.addEventListener('click', () => {
        const v = out.videos.find((x) => String(x.id) === b.getAttribute('data-edit'));
        openVideoForm(v);
      }));
      els('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
        const next = b.getAttribute('data-status') === 'active' ? 'inactive' : 'active';
        b.disabled = true;
        try {
          await API.post(`/api/admin/videos/${b.getAttribute('data-toggle')}/status`, { status: next });
          toast(`Video ${next === 'active' ? 'enabled' : 'disabled'}`);
          renderVideos();
        } catch (e) { toast(e.message, 'error'); b.disabled = false; }
      }));
      els('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
        if (!window.confirm('Delete this video? It will be hidden from the task list.')) return;
        b.disabled = true;
        try {
          await API.del(`/api/admin/videos/${b.getAttribute('data-delete')}`);
          toast('Video deleted');
          renderVideos();
        } catch (e) { toast(e.message, 'error'); b.disabled = false; }
      }));
    } catch (e) {
      paint('Videos', '', `<div class="admin-empty"><strong>Could not load videos</strong>${esc(e.message)}</div>`, addBtn);
      el('#add-video').addEventListener('click', () => openVideoForm(null));
    }
  }

  function openVideoForm(video) {
    const isEdit = Boolean(video);
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h2>${isEdit ? 'Edit video' : 'Add video'}</h2>
        <p class="modal__sub">Rewards are credited only for server-verified watch sessions.</p>
        <div class="form-grid">
          <div class="a-field full">
            <label for="v-title">Title</label>
            <input id="v-title" value="${esc(video ? video.title : '')}" placeholder="Daily Video — …" />
            <div class="a-field__error" data-error="title"></div>
          </div>
          <div class="a-field full">
            <label for="v-desc">Description</label>
            <textarea id="v-desc" placeholder="Short description shown on the task card">${esc(video ? video.description : '')}</textarea>
          </div>
          <div class="a-field full">
            <label for="v-url">Video URL</label>
            <input id="v-url" value="${esc(video ? video.video_url : '')}" placeholder="https://www.youtube-nocookie.com/embed/…" />
            <div class="a-field__error" data-error="video_url"></div>
          </div>
          <div class="a-field">
            <label for="v-duration">Duration (seconds)</label>
            <input id="v-duration" type="number" min="5" value="${video ? video.duration_seconds : 90}" />
            <div class="a-field__error" data-error="duration_seconds"></div>
          </div>
          <div class="a-field">
            <label for="v-reward">Reward (KES)</label>
            <input id="v-reward" type="number" min="1" step="0.5" value="${video ? video.reward : 5}" />
            <div class="a-field__error" data-error="reward"></div>
          </div>
          <div class="a-field">
            <label for="v-limit">Daily completion limit</label>
            <input id="v-limit" type="number" min="1" value="${video ? video.daily_limit : 1}" />
            <div class="a-field__error" data-error="daily_limit"></div>
          </div>
          <div class="a-field">
            <label for="v-status">Status</label>
            <select id="v-status">
              <option value="active"${!video || video.status === 'active' ? ' selected' : ''}>Active</option>
              <option value="inactive"${video && video.status === 'inactive' ? ' selected' : ''}>Inactive</option>
            </select>
          </div>
        </div>
        <div class="form-actions">
          <button class="a-btn a-btn--primary" id="v-save">${isEdit ? 'SAVE CHANGES' : 'ADD VIDEO'}</button>
          <button class="a-btn" id="v-cancel">CANCEL</button>
        </div>
      </div>`;
    modalHost.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    el('#v-cancel', modal).addEventListener('click', () => modal.remove());

    el('#v-save', modal).addEventListener('click', async () => {
      const body = {
        title: el('#v-title', modal).value.trim(),
        description: el('#v-desc', modal).value.trim(),
        video_url: el('#v-url', modal).value.trim(),
        duration_seconds: Number(el('#v-duration', modal).value),
        reward: Number(el('#v-reward', modal).value),
        daily_limit: Number(el('#v-limit', modal).value),
        status: el('#v-status', modal).value,
      };
      els('[data-error]', modal).forEach((n) => { n.textContent = ''; });
      const btn = el('#v-save', modal);
      btn.disabled = true; btn.textContent = 'SAVING…';
      try {
        if (isEdit) await API.put(`/api/admin/videos/${video.id}`, body);
        else await API.post('/api/admin/videos', body);
        modal.remove();
        toast(isEdit ? 'Video updated' : 'Video created');
        renderVideos();
      } catch (e) {
        const errs = (e.data && e.data.errors) || {};
        const first = Object.keys(errs)[0];
        if (first) el(`[data-error="${first}"]`, modal).textContent = errs[first];
        else toast(e.message, 'error');
        btn.disabled = false; btn.textContent = isEdit ? 'SAVE CHANGES' : 'ADD VIDEO';
      }
    });
  }

  async function renderDeposits() {
    paint('Deposits', 'Every deposit is verified against the payment provider.', loading);
    try {
      const out = await API.get('/api/admin/deposits');
      state.provider = out.payment_provider;
      paint('Deposits', 'Every deposit is verified against the payment provider.', out.deposits.length ? `
        <div class="banner">
          Provider confirmations arrive by callback (${esc(out.payment_provider.label)}). Use <strong>Verify</strong> to
          re-check a pending payment with the provider — an operator cannot mark a deposit successful.
        </div>
        <div class="panel">
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Transaction ID</th><th>User</th><th>Amount</th><th>Payment reference</th><th>Date</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                ${out.deposits.map((d) => `
                  <tr>
                    <td class="mono">${esc(d.txn_id)}</td>
                    <td>${esc(d.username)}</td>
                    <td>${esc(money(d.amount, d.currency_code))}</td>
                    <td class="mono">${esc(d.payment_reference || '—')}</td>
                    <td class="mono">${esc(dateTime(d.created_at))}</td>
                    <td>${statusPill(d.status)}</td>
                    <td class="actions">
                      ${d.status === 'pending' ? `
                        <button class="a-btn a-btn--sm" data-verify="${d.id}">VERIFY</button>
                        ${out.payment_provider.sandbox ? `<button class="a-btn a-btn--sm" data-simulate="${d.id}">SIMULATE</button>` : ''}
                      ` : '<span style="color:var(--text-2);font-size:12.5px">Settled</span>'}
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>` : empty('No deposits yet', 'Deposits appear here as soon as users initiate them.'));

      els('[data-verify]').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = 'CHECKING…';
        try {
          const res = await API.post(`/api/admin/deposits/${b.getAttribute('data-verify')}/verify`);
          toast(res.note || `Provider result: ${res.provider_result}`, res.deposit.status === 'successful' ? 'success' : 'warn');
          renderDeposits();
        } catch (e) { toast(e.message, 'error'); b.disabled = false; b.textContent = 'VERIFY'; }
      }));
      els('[data-simulate]').forEach((b) => b.addEventListener('click', async () => {
        if (!window.confirm('Sandbox only: mark this deposit as if the provider confirmed it? No real M-Pesa payment is involved.')) return;
        b.disabled = true;
        try {
          await API.post(`/api/admin/deposits/${b.getAttribute('data-simulate')}/simulate`, { result: 'SUCCESS' });
          toast('Sandbox confirmation recorded');
          renderDeposits();
        } catch (e) { toast(e.message, 'error'); b.disabled = false; }
      }));
    } catch (e) {
      paint('Deposits', '', `<div class="admin-empty"><strong>Could not load deposits</strong>${esc(e.message)}</div>`);
    }
  }

  async function renderWithdrawals() {
    paint('Withdrawals', 'Payouts are sent through the payment provider.', loading);
    try {
      const out = await API.get('/api/admin/withdrawals');
      state.provider = out.payment_provider;
      paint('Withdrawals', 'Payouts are sent through the payment provider.', out.withdrawals.length ? `
        <div class="banner">
          Submitting a payout hands it to ${esc(out.payment_provider.label)}. A request only becomes <strong>Completed</strong>
          when the provider confirms the transfer — there is no manual “mark as paid”.
        </div>
        <div class="panel">
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Request ID</th><th>User</th><th>Amount</th><th>M-Pesa number</th><th>Created</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                ${out.withdrawals.map((w) => `
                  <tr>
                    <td class="mono">${esc(w.request_id)}</td>
                    <td>${esc(w.username)}</td>
                    <td>${esc(money(w.amount, w.currency_code))}<br><span style="font-size:12px;color:var(--text-2)">net ${esc(money(w.net_amount, w.currency_code))}</span></td>
                    <td class="mono">${esc(w.destination)}</td>
                    <td class="mono">${esc(dateTime(w.created_at))}</td>
                    <td>${statusPill(w.status)}</td>
                    <td class="actions">
                      ${['pending', 'processing'].includes(w.status) ? `
                        <button class="a-btn a-btn--sm" data-process="${w.id}">${w.provider ? 'CHECK STATUS' : 'SUBMIT PAYOUT'}</button>
                        ${out.payment_provider.sandbox ? `
                          <button class="a-btn a-btn--sm a-btn--danger" data-fail="${w.id}">MARK FAILED</button>
                          <button class="a-btn a-btn--sm" data-simulate="${w.id}">SIMULATE SUCCESS</button>` : ''}
                      ` : '<span style="color:var(--text-2);font-size:12.5px">Settled</span>'}
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>` : empty('No withdrawal requests', 'Requests appear here as soon as users submit them.'));

      els('[data-process]').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = 'WORKING…';
        try {
          const res = await API.post(`/api/admin/withdrawals/${b.getAttribute('data-process')}/process`);
          toast(res.message || `Provider result: ${res.provider_result || res.withdrawal.status}`, 'warn', 6000);
          renderWithdrawals();
        } catch (e) { toast(e.message, 'error'); b.disabled = false; b.textContent = 'SUBMIT PAYOUT'; }
      }));
      els('[data-fail]').forEach((b) => b.addEventListener('click', async () => {
        if (!window.confirm('Mark this payout as failed? The reserved amount returns to the user\'s available balance.')) return;
        b.disabled = true;
        try {
          await API.post(`/api/admin/withdrawals/${b.getAttribute('data-fail')}/simulate`, { result: 'FAILED' });
          toast('Payout marked failed and funds released', 'warn');
          renderWithdrawals();
        } catch (e) { toast(e.message, 'error'); b.disabled = false; }
      }));
      els('[data-simulate]').forEach((b) => b.addEventListener('click', async () => {
        if (!window.confirm('Sandbox only: simulate a successful payout? No real money is transferred.')) return;
        b.disabled = true;
        try {
          await API.post(`/api/admin/withdrawals/${b.getAttribute('data-simulate')}/simulate`, { result: 'SUCCESS' });
          toast('Sandbox payout confirmation recorded');
          renderWithdrawals();
        } catch (e) { toast(e.message, 'error'); b.disabled = false; }
      }));
    } catch (e) {
      paint('Withdrawals', '', `<div class="admin-empty"><strong>Could not load withdrawals</strong>${esc(e.message)}</div>`);
    }
  }

  async function renderRewards() {
    paint('Rewards', 'Every reward entry in the wallet ledger.', loading);
    try {
      const out = await API.get('/api/admin/rewards');
      paint('Rewards', 'Every reward entry in the wallet ledger.', `
        <div class="cards">
          <div class="metric"><div class="metric__label">Watch rewards issued</div><div class="metric__value">${esc(money(out.totals.watch_rewards))}</div></div>
          <div class="metric"><div class="metric__label">Referral rewards issued</div><div class="metric__value">${esc(money(out.totals.referral_rewards))}</div></div>
          <div class="metric"><div class="metric__label">Reward entries</div><div class="metric__value">${out.rewards.length}</div></div>
        </div>
        <div class="panel">
          ${out.rewards.length ? `
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Transaction</th><th>User</th><th>Type</th><th>Amount</th><th>Description</th><th>Status</th><th>Date</th></tr></thead>
              <tbody>
                ${out.rewards.map((r) => `
                  <tr>
                    <td class="mono">${esc(r.txn_id)}</td>
                    <td>${esc(r.username)}</td>
                    <td>${esc(r.type)}</td>
                    <td>${esc(money(r.amount, r.currency_code))}</td>
                    <td>${esc(r.description)}</td>
                    <td>${statusPill(r.status)}</td>
                    <td class="mono">${esc(dateTime(r.created_at))}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : empty('No rewards issued yet', 'Rewards appear once verified watch sessions are claimed.')}
        </div>`);
    } catch (e) {
      paint('Rewards', '', `<div class="admin-empty"><strong>Could not load rewards</strong>${esc(e.message)}</div>`);
    }
  }

  async function renderReferrals() {
    paint('Referrals', 'Referral relationships and credited commissions.', loading);
    try {
      const out = await API.get('/api/admin/referrals');
      paint('Referrals', 'Referral relationships and credited commissions.', out.referrals.length ? `
        <div class="panel">
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Referrer</th><th>Referred user</th><th>Level</th><th>Commission</th><th>Condition</th><th>Joined</th></tr></thead>
              <tbody>
                ${out.referrals.map((r) => `
                  <tr>
                    <td>${esc(r.referrer)}</td>
                    <td>${esc(r.referred)}</td>
                    <td>${Number(r.level)}</td>
                    <td>${esc(money(r.commission))}</td>
                    <td>${r.qualified ? '<span class="pill pill--success">Qualified</span>' : '<span class="pill pill--warning">Pending</span>'}</td>
                    <td class="mono">${esc(dateTime(r.created_at))}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>` : empty('No referrals yet', 'Referrals appear when users register with a referral code.'));
    } catch (e) {
      paint('Referrals', '', `<div class="admin-empty"><strong>Could not load referrals</strong>${esc(e.message)}</div>`);
    }
  }

  async function renderNotifications() {
    paint('Notifications', 'Broadcast platform announcements to every user.', loading);
    try {
      const out = await API.get('/api/admin/notifications');
      paint('Notifications', 'Broadcast platform announcements to every user.', `
        <div class="panel">
          <div class="panel__head"><div><h2>Send a notification</h2><p>Delivered to all users and pushed over WebSocket.</p></div></div>
          <div class="form-grid">
            <div class="a-field full">
              <label for="n-title">Title</label>
              <input id="n-title" placeholder="e.g. New videos available" />
              <div class="a-field__error" data-error="title"></div>
            </div>
            <div class="a-field full">
              <label for="n-message">Message</label>
              <textarea id="n-message" placeholder="Write the message users will see."></textarea>
              <div class="a-field__error" data-error="message"></div>
            </div>
            <div class="a-field">
              <label for="n-type">Type</label>
              <select id="n-type">
                <option value="info">Info</option>
                <option value="success">Success</option>
                <option value="warning">Warning</option>
                <option value="danger">Important</option>
              </select>
            </div>
          </div>
          <div class="form-actions"><button class="a-btn a-btn--primary" id="n-send">SEND BROADCAST</button></div>
        </div>
        <div class="panel">
          <div class="panel__head"><div><h2>Recent notifications</h2><p>Newest first.</p></div></div>
          ${out.notifications.length ? `
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Title</th><th>Message</th><th>Audience</th><th>Type</th><th>Date</th></tr></thead>
              <tbody>
                ${out.notifications.slice(0, 60).map((n) => `
                  <tr>
                    <td><strong>${esc(n.title)}</strong></td>
                    <td>${esc(String(n.message).slice(0, 90))}</td>
                    <td>${n.user_id ? `user #${n.user_id}` : 'All users'}</td>
                    <td>${esc(n.type)}</td>
                    <td class="mono">${esc(dateTime(n.created_at))}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : empty('No notifications sent yet', 'Broadcasts you send will be listed here.')}
        </div>`);

      el('#n-send').addEventListener('click', async () => {
        const title = el('#n-title').value.trim();
        const message = el('#n-message').value.trim();
        const type = el('#n-type').value;
        els('[data-error]').forEach((n) => { n.textContent = ''; });
        if (!title || !message) { el('[data-error="title"]').textContent = 'Title and message are required'; return; }
        const btn = el('#n-send');
        btn.disabled = true; btn.textContent = 'SENDING…';
        try {
          await API.post('/api/admin/notifications/broadcast', { title, message, type });
          toast('Notification sent');
          renderNotifications();
        } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'SEND BROADCAST'; }
      });
    } catch (e) {
      paint('Notifications', '', `<div class="admin-empty"><strong>Could not load notifications</strong>${esc(e.message)}</div>`);
    }
  }

  async function renderSettings() {
    paint('Settings', 'Operational limits shown across the mobile app.', loading);
    try {
      const out = await API.get('/api/admin/settings');
      const s = out.settings;
      paint('Settings', 'Operational limits shown across the mobile app.', `
        <div class="panel">
          <div class="panel__head"><div><h2>Wallet & payout rules</h2><p>Applied immediately to new deposits, withdrawals and watch rewards.</p></div></div>
          <div class="form-grid">
            <div class="a-field"><label for="s-minw">Minimum withdrawal (KES)</label><input id="s-minw" type="number" value="${esc(s.min_withdrawal)}" /></div>
            <div class="a-field"><label for="s-fee">Withdrawal fee (%)</label><input id="s-fee" type="number" step="0.1" value="${esc(s.withdrawal_fee_pct)}" /></div>
            <div class="a-field"><label for="s-proc">Expected processing</label><input id="s-proc" value="${esc(s.expected_processing)}" /></div>
            <div class="a-field"><label for="s-mind">Minimum deposit (KES)</label><input id="s-mind" type="number" value="${esc(s.min_deposit)}" /></div>
            <div class="a-field"><label for="s-maxd">Maximum deposit (KES)</label><input id="s-maxd" type="number" value="${esc(s.max_deposit)}" /></div>
            <div class="a-field"><label for="s-daily">Daily watch limit</label><input id="s-daily" type="number" value="${esc(s.watch_daily_limit)}" /></div>
            <div class="a-field"><label for="s-pct">Required watch share (0–1)</label><input id="s-pct" type="number" step="0.05" min="0.1" max="1" value="${esc(s.watch_required_pct)}" /></div>
            <div class="a-field"><label for="s-ref">Referral reward (KES)</label><input id="s-ref" type="number" value="${esc(s.referral_reward)}" /></div>
            <div class="a-field"><label for="s-support">Support email</label><input id="s-support" value="${esc(s.support_email)}" /></div>
            <div class="a-field full"><label for="s-rules">Referral rules (one per line)</label><textarea id="s-rules">${esc(s.referral_rules)}</textarea></div>
          </div>
          <div class="form-actions"><button class="a-btn a-btn--primary" id="s-save">SAVE SETTINGS</button></div>
        </div>`);

      el('#s-save').addEventListener('click', async () => {
        const body = {
          min_withdrawal: Number(el('#s-minw').value),
          withdrawal_fee_pct: Number(el('#s-fee').value),
          expected_processing: el('#s-proc').value.trim(),
          min_deposit: Number(el('#s-mind').value),
          max_deposit: Number(el('#s-maxd').value),
          watch_daily_limit: Number(el('#s-daily').value),
          watch_required_pct: Number(el('#s-pct').value),
          referral_reward: Number(el('#s-ref').value),
          support_email: el('#s-support').value.trim(),
          referral_rules: el('#s-rules').value.trim(),
        };
        const btn = el('#s-save');
        btn.disabled = true; btn.textContent = 'SAVING…';
        try {
          await API.put('/api/admin/settings', body);
          toast('Settings updated');
          renderSettings();
        } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'SAVE SETTINGS'; }
      });
    } catch (e) {
      paint('Settings', '', `<div class="admin-empty"><strong>Could not load settings</strong>${esc(e.message)}</div>`);
    }
  }

  async function renderAudit() {
    paint('Audit Logs', 'Immutable record of admin and financial activity.', loading);
    try {
      const out = await API.get('/api/admin/audit-logs');
      paint('Audit Logs', 'Immutable record of admin and financial activity.', out.logs.length ? `
        <div class="panel">
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
              <tbody>
                ${out.logs.map((l) => `
                  <tr>
                    <td class="mono">${esc(dateTime(l.created_at))}</td>
                    <td>${esc(l.actor_role || 'system')}${l.actor_id ? ` #${l.actor_id}` : ''}</td>
                    <td><strong>${esc(l.action)}</strong></td>
                    <td class="mono">${esc(l.target_type || '')}${l.target_id ? ` ${esc(l.target_id)}` : ''}</td>
                    <td>${esc(l.detail || '')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>` : empty('No audit entries yet', 'Admin actions and financial events will be recorded here.'));
    } catch (e) {
      paint('Audit Logs', '', `<div class="admin-empty"><strong>Could not load audit logs</strong>${esc(e.message)}</div>`);
    }
  }

  /* ── boot ────────────────────────────────────────────── */
  async function boot() {
    try {
      const me = await API.get('/api/auth/me');
      if (!me.user || me.user.role !== 'admin') return renderGate('That account does not have admin access.');
      state.admin = me.user;
    } catch {
      return renderGate();
    }

    try {
      const provider = await API.get('/api/mpesa/provider');
      state.provider = provider;
    } catch { /* provider info is optional */ }

    renderSection();
  }

  boot();
})();
