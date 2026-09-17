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

const app = express();
const server = http.createServer(app);
ws.init(server);

// ── Security & parsing ────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: config.isProd ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      mediaSrc: ["'self'", 'https:', 'blob:'],
      frameSrc: ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://player.vimeo.com'],
      connectSrc: ["'self'", 'wss:', 'ws:'],
    },
  } : false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(cookieParser());

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (config.corsOrigins.includes(origin)) return cb(null, true);
    return cb(null, !config.isProd);
  },
  credentials: true,
};
app.use(cors(corsOptions));

// ── Rate limiting ─────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 25, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts — please try again in 15 minutes' },
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests — please slow down' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/', apiLimiter);

app.use(attachUser);
// Keep a valid CSRF cookie on hand for the SPA.
app.use((req, res, next) => {
  if (req.method === 'GET' && !(req.cookies && req.cookies.wr_csrf)) issueCsrf(res);
  next();
});

// ── API routes ────────────────────────────────────────────
// Payment provider callbacks first: server-to-server, CSRF-exempt, matched to
// stored provider references and reconciled idempotently.
app.use('/api/mpesa', require('./routes/mpesa'));

// Double-submit CSRF guard for every other state-changing call.
app.use('/api', csrfGuard);

app.use('/api/public', require('./routes/public'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/home', require('./routes/home'));
app.use('/api/watch', require('./routes/watch'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/team', require('./routes/team'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/admin', require('./routes/admin'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ── Static frontend ───────────────────────────────────────
const pub = path.join(__dirname, '..', 'frontend');
app.use(express.static(pub, { maxAge: config.isProd ? '1h' : 0 }));

// SPA deep links (/login, /watch/12 …) resolve to the app shell. API and asset
// paths are excluded so missing files still 404 properly.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || path.extname(req.path)) return next();
  res.sendFile(path.join(pub, 'index.html'));
});

// ── Error handling ────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  if (!res.headersSent) {
    res.status(err.status || 500).json({ error: config.isProd ? 'Something went wrong' : err.message });
  }
});

// ── Boot ──────────────────────────────────────────────────
(async () => {
  await db.init();
  const port = config.port;
  server.listen(port, () => {
    const payments = require('./services/payments');
    const p = payments.describe();
    console.log(`\n  ${config.brand} → http://localhost:${port}  (db: ${db.mode})`);
    console.log(`  Payments: ${p.label} [${p.mode}]${p.sandbox ? ' — no real M-Pesa payments in this mode' : ''}`);
    console.log(`  WebSocket: /ws\n`);
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
