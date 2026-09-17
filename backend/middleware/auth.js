/**
 * Authentication middleware.
 *
 * - JWT in an httpOnly cookie (`wr_token`) or `Authorization: Bearer`.
 * - Every token carries a session id; `requireAuth` rejects tokens whose
 *   session was revoked, which is what makes "Logout all devices" real rather
 *   than cosmetic.
 * - Double-submit CSRF guard on every state-changing API call.
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');
const { Table } = require('../db');

const sessions = new Table('login_sessions');

const TOKEN_COOKIE = 'wr_token';
const CSRF_COOKIE = 'wr_csrf';

function sign(user, sessionId = null) {
  return jwt.sign(
    { sub: String(user.id), role: user.role || 'user', username: user.username, sid: sessionId || null },
    config.jwtSecret,
    { expiresIn: config.jwtExpires },
  );
}

function attachUser(req, _res, next) {
  req.user = null;
  let token = null;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) token = header.slice(7);
  if (!token && req.cookies) token = req.cookies[TOKEN_COOKIE];
  if (token) {
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      req.user = {
        id: payload.sub,
        role: payload.role || 'user',
        username: payload.username,
        sessionId: payload.sid || null,
      };
    } catch { /* invalid/expired */ }
  }
  next();
}

/** Sets the session cookies (httpOnly JWT + readable CSRF pair). */
function setSessionCookies(res, token, csrf) {
  res.cookie(TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.isProd,
    maxAge: 30 * 24 * 3600 * 1000,
  });
  if (csrf) res.cookie(CSRF_COOKIE, csrf, {
    sameSite: 'strict',
    secure: config.isProd,
    maxAge: 12 * 60 * 60 * 1000,
  });
}

function clearSessionCookies(res) {
  res.clearCookie(TOKEN_COOKIE);
  res.clearCookie(CSRF_COOKIE);
}

/**
 * Verifies the token's session row is still valid (revocation-aware).
 * Returns the session row when there is one, otherwise null.
 */
async function sessionState(user) {
  if (!user || !user.sessionId) return { known: false, revoked: false, row: null };
  const row = await sessions.get({ session_id: user.sessionId });
  if (!row) return { known: false, revoked: false, row: null };
  return { known: true, revoked: Boolean(row.revoked), row };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required', code: 'SESSION_EXPIRED' });
  sessionState(req.user)
    .then((state) => {
      if (state.revoked) {
        clearSessionCookies(res);
        return res.status(401).json({ error: 'This session has ended. Please sign in again.', code: 'SESSION_REVOKED' });
      }
      if (state.known && state.row) {
        // Best-effort activity stamp — never blocks the request.
        sessions.update(state.row.id, { last_seen_at: new Date().toISOString() }).catch(() => {});
      }
      next();
    })
    .catch(next);
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Public, pre-session endpoints — rate-limited instead of CSRF-guarded
const CSRF_EXEMPT = [
  '/api/auth/login', '/api/auth/register', '/api/auth/forgot-password',
  '/api/auth/reset-password', '/api/auth/logout',
];

function csrfGuard(req, res, next) {
  const safe = ['GET', 'HEAD', 'OPTIONS'];
  if (safe.includes(req.method)) return next();
  // Payment provider callbacks are server-to-server (authenticated by provider
  // origin/reference checks and by idempotent reconciliation).
  if (req.originalUrl.startsWith('/api/mpesa/')) return next();
  if (CSRF_EXEMPT.some((p) => req.originalUrl.startsWith(p))) return next();

  const cookie = req.cookies && req.cookies[CSRF_COOKIE];
  const header = req.headers['x-csrf-token'];

  if (!cookie || !header || cookie !== header) {
    return res.status(403).json({ error: 'CSRF token missing or mismatched' });
  }
  const idx = cookie.lastIndexOf('.');
  if (idx < 0) return res.status(403).json({ error: 'Malformed CSRF token' });
  const body = cookie.slice(0, idx);
  const sig = cookie.slice(idx + 1);
  const expect = crypto.createHmac('sha256', config.csrfSecret).update(body).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Invalid CSRF signature' });
  }
  const exp = Number(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')).exp);
  if (!exp || Date.now() > exp) return res.status(403).json({ error: 'CSRF token expired' });
  next();
}

function issueCsrf(res) {
  const exp = Date.now() + 1000 * 60 * 60 * 12;
  const body = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.csrfSecret).update(body).digest('hex');
  const value = `${body}.${sig}`;
  res.cookie(CSRF_COOKIE, value, {
    sameSite: 'strict',
    secure: config.isProd,
    maxAge: 12 * 60 * 60 * 1000,
  });
  return value;
}

module.exports = {
  TOKEN_COOKIE, CSRF_COOKIE, sign, attachUser, requireAuth, requireAdmin,
  csrfGuard, issueCsrf, setSessionCookies, clearSessionCookies, sessionState,
};
