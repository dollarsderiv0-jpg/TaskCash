const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');

function sign(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role || 'user', username: user.username },
    config.jwtSecret,
    { expiresIn: config.jwtExpires }
  );
}

function attachUser(req, _res, next) {
  req.user = null;
  let token = null;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) token = header.slice(7);
  if (!token && req.cookies) token = req.cookies.taskcash_token;
  if (token) {
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      req.user = { id: payload.sub, role: payload.role || 'user', username: payload.username };
    } catch { /* invalid/expired */ }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

/**
 * Double-submit cookie CSRF guard for state-changing requests.
 * - Session cookie is SameSite=Strict (see server.js) which already blocks
 *   most cross-site POSTs; this adds a strict token comparison on top.
 * - Client must send cookie `taskcash_csrf` AND header `x-csrf-token` with
 *   the same value, and that value must decode to `exp.sig` with sig =
 *   HMAC(secret, value-without-sig).
 */
// Public, pre-session endpoints — rate-limited instead of CSRF-guarded
const CSRF_EXEMPT = [
  '/api/auth/login', '/api/auth/register', '/api/auth/forgot-password',
  '/api/auth/reset-password', '/api/auth/verify-email', '/api/auth/logout',
];

function csrfGuard(req, res, next) {
  const safe = ['GET', 'HEAD', 'OPTIONS'];
  if (safe.includes(req.method)) return next();
  // M-Pesa server-to-server callback (authenticated by Daraja origin checks / demo)
  if (req.originalUrl.startsWith('/api/mpesa/')) return next();
  if (CSRF_EXEMPT.some((p) => req.originalUrl.startsWith(p))) return next();

  const cookie = req.cookies && req.cookies.taskcash_csrf;
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
  res.cookie('taskcash_csrf', value, {
    sameSite: 'strict',
    secure: config.isProd,
    maxAge: 12 * 60 * 60 * 1000,
  });
  return value;
}

module.exports = { sign, attachUser, requireAuth, requireAdmin, csrfGuard, issueCsrf };
