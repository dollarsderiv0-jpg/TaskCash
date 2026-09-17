/** WebSocket hub (ws) — user channels + admin broadcast + public earnings feed. */
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { Table } = require('../db');

let wss = null;
const clients = new Map(); // ws -> { userId, role, guest }

function init(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const meta = { userId: null, role: 'guest' };
    try {
      const url = new URL(req.url, 'http://x');
      const t = url.searchParams.get('token') ||
        (req.headers.cookie || '').match(/wr_token=([^;]+)/)?.[1];
      if (t) {
        const payload = jwt.verify(t, config.jwtSecret);
        meta.userId = payload.sub;
        meta.role = payload.role || 'user';
        meta.sessionId = payload.sid || null;
      }
    } catch { /* guest */ }
    clients.set(ws, meta);

    // Revoked sessions may not subscribe to live updates.
    if (meta.sessionId) {
      new Table('login_sessions').get({ session_id: meta.sessionId })
        .then((row) => { if (row && row.revoked) clients.delete(ws); })
        .catch(() => {});
    }

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (raw) => {
      // tiny protocol: {"type":"ping"}
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
      } catch { /* ignore */ }
    });

    ws.send(JSON.stringify({ type: 'hello', authenticated: Boolean(meta.userId) }));
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30000);
  if (interval.unref) interval.unref();

  return wss;
}

function sendTo(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function sendToUser(userId, payload) {
  if (!wss) return;
  for (const [ws, meta] of clients) {
    if (String(meta.userId) === String(userId)) sendTo(ws, payload);
  }
}

function broadcastAdmins(payload) {
  if (!wss) return;
  for (const [ws, meta] of clients) {
    if (meta.role === 'admin') sendTo(ws, payload);
  }
}

function broadcastAll(payload) {
  if (!wss) return;
  for (const ws of wss.clients) sendTo(ws, payload);
}

function clientCount() { return wss ? wss.clients.size : 0; }

module.exports = { init, sendToUser, broadcastAdmins, broadcastAll, clientCount };
