/**
 * Watch & Earn routes (sections 06, 07, 15).
 *
 * Rewards are only ever produced by services/watch.claimReward(), which
 * validates the server-side session before the ledger is touched.
 */
const express = require('express');
const { Table } = require('../db');
const { wrap, r2, clientIp } = require('../lib/helpers');
const { requireAuth } = require('../middleware/auth');
const watch = require('../services/watch');
const ledger = require('../services/ledger');

const router = express.Router();
const users = new Table('users');

// ── Task list ─────────────────────────────────────────────
router.get('/videos', requireAuth, wrap(async (req, res) => {
  res.json(await watch.listVideos(req.user.id));
}));

// ── Start a watch session ─────────────────────────────────
router.post('/sessions', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

  const videoId = Number(req.body.video_id);
  if (!videoId) return res.status(400).json({ error: 'video_id is required' });

  const { session, video, resumed } = await watch.startSession({
    user,
    videoId,
    ip: clientIp(req),
    userAgent: req.headers['user-agent'],
  });

  res.status(resumed ? 200 : 201).json({
    session: {
      id: session.id,
      video_id: session.video_id,
      status: session.status,
      started_at: session.started_at,
      required_seconds: session.required_seconds,
      watched_seconds: session.watched_seconds,
      progress_pct: session.progress_pct,
    },
    video: {
      id: video.id,
      title: video.title,
      description: video.description,
      video_url: video.video_url,
      duration_seconds: Number(video.duration_seconds),
      reward: r2(video.reward),
      currency_code: video.currency_code,
    },
    resumed,
  });
}));

// ── Report progress (server clamps what it accepts) ───────
router.post('/sessions/:id/progress', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const out = await watch.recordProgress({
    user,
    sessionId: req.params.id,
    watchedSeconds: req.body.watched_seconds,
    progressPct: req.body.progress_pct,
  });
  res.json({
    session_id: out.session.id,
    status: out.session.status,
    watched_seconds: out.watched_seconds != null ? out.watched_seconds : Number(out.session.watched_seconds),
    progress_pct: out.progress_pct != null ? out.progress_pct : Number(out.session.progress_pct),
    required_seconds: out.required_seconds || Number(out.session.required_seconds),
    eligible: Boolean(out.eligible),
  });
}));

// ── Claim (backend validates, then the ledger credits) ────
router.post('/sessions/:id/claim', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

  try {
    const out = await watch.claimReward({ user, sessionId: req.params.id });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code || null });
  }
}));

// ── Rewards screen ────────────────────────────────────────
router.get('/rewards', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(await watch.rewardsSummary(user));
}));

// ── History of verified watch rewards ─────────────────────
router.get('/history', requireAuth, wrap(async (req, res) => {
  const { rows } = await ledger.history(req.user.id, { filter: 'earnings', limit: 50 });
  res.json({
    rewards: rows
      .filter((r) => r.type === 'WATCH_REWARD')
      .map((r) => ({
        txn_id: r.txn_id,
        description: r.description,
        amount: r2(r.amount),
        currency_code: r.currency_code,
        status: r.status,
        created_at: r.created_at,
      })),
  });
}));

module.exports = router;
