require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const db = require('./db');
const ws = require('./lib/ws');
const { attachUser, csrfGuard, issueCsrf } = require('./middleware/auth');
const { wrap } = require('./lib/helpers');

const app = express();
const server = http.createServer(app);
ws.init(server);

// ── Security & parsing ────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: config.isProd ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      mediaSrc: ["'self'", 'https:', 'blob:'],
      frameSrc: ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
      connectSrc: ["'self'", 'wss:', 'ws:'],
    },
  } : false,
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false, limit: '4mb' }));
app.use(cookieParser());

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (config.corsOrigins.includes(origin)) return cb(null, true);
    return cb(null, config.isProd ? false : true);
  },
  credentials: true,
};
app.use(cors(corsOptions));

// ── Rate limiting ─────────────────────────────────────────
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts — try again in 15 minutes' } });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests — slow down' } });
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/', apiLimiter);

app.use(attachUser);
// Refresh CSRF cookie on any GET that lacks a valid one
app.use((req, res, next) => {
  if (req.method === 'GET' && !(req.cookies && req.cookies.taskcash_csrf)) issueCsrf(res);
  next();
});

// ── API routes ────────────────────────────────────────────
// M-Pesa server-to-server callback first (CSRF-exempt, guarded by Daraja origin)
app.use('/api/mpesa', require('./routes/mpesa'));

// CSRF double-submit guard for every other state-changing API call
app.use('/api', csrfGuard);

app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/dashboard'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/admin', require('./routes/admin'));

// 404 for unknown API paths
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ── Static frontend ───────────────────────────────────────
const pub = path.join(__dirname, '..', 'frontend');
app.use(express.static(pub, { maxAge: config.isProd ? '1h' : 0 }));

// ── Error handling ────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  if (!res.headersSent) res.status(err.status || 500).json({ error: config.isProd ? 'Something went wrong' : err.message });
});

// ── Boot ──────────────────────────────────────────────────
(async () => {
  await db.init();
  const port = config.port;
  server.listen(port, () => {
    console.log(`\n  TaskCash Kenya → http://localhost:${port}  (${db.mode} mode)`);
    console.log(`  M-Pesa: ${config.mpesa.enabled ? 'live Daraja' : 'demo mode'} · WS: /ws\n`);
  });
})();

async function shutdown() {
  console.log('\nShutting down…');
  server.close(() => process.exit(0));
  await db.getDb?.().close?.().catch(() => {});
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
