/** TaskCash frontend — API client with cookie auth + CSRF header. */
const API = {
  csrf: localStorage.getItem('tc_csrf') || '',

  async request(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    const res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    // Keep CSRF token fresh (server re-issues cookie when missing/expired)
    const fresh = res.headers.get('x-csrf-token') || (document.cookie.match(/taskcash_csrf=([^;]+)/) || [])[1];
    if (fresh && fresh !== this.csrf) { this.csrf = fresh; localStorage.setItem('tc_csrf', fresh); }
    if (res.status === 401 && !path.startsWith('/api/auth')) {
      localStorage.removeItem('tc_user');
      if (!location.pathname.includes('login')) location.href = '/login.html';
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  },

  get(path) { return this.request(path); },
  post(path, body) { return this.request(path, { method: 'POST', body: body || {} }); },
  put(path, body) { return this.request(path, { method: 'PUT', body: body || {} }); },
  del(path) { return this.request(path, { method: 'DELETE' }); },

  setSession({ token, csrf, user }) {
    if (csrf) { this.csrf = csrf; localStorage.setItem('tc_csrf', csrf); }
    if (token) localStorage.setItem('tc_token', token); // fallback for WS auth
    if (user) localStorage.setItem('tc_user', JSON.stringify(user));
  },
  user() {
    try { return JSON.parse(localStorage.getItem('tc_user') || 'null'); } catch { return null; }
  },
  clearSession() {
    localStorage.removeItem('tc_csrf');
    localStorage.removeItem('tc_token');
    localStorage.removeItem('tc_user');
  },
};
window.API = API;
