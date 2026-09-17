/**
 * Watch & Earn engine (sections 06, 07).
 *
 * The client can never award itself a reward. A reward exists only when the
 * server has a `watch_sessions` row that satisfies every condition below:
 *
 *   1. the session belongs to the requesting user and is still pending;
 *   2. the server-observed watch time (>= 90% of the video duration by default)
 *      is met — reported progress can only ever move forward, is capped at the
 *      video duration, and is cross-checked against real elapsed wall-clock
 *      time since the session started;
 *   3. the per-video daily completion limit (and the platform daily limit) is
 *      not exceeded;
 *   4. the reward has not already been credited for this session
 *      (ledger idempotency key `watch:<session_id>`).
 */
const { Table } = require('../db');
const config = require('../config');
const { r2, clientIp } = require('../lib/helpers');
const ledger = require('./ledger');
const notify = require('./notify');
const settings = require('./settings');
const ws = require('../lib/ws');

const videos = new Table('videos');
const sessions = new Table('watch_sessions');
const users = new Table('users');
const referrals = new Table('referrals');

const dayStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const sameDay = (iso, ref = new Date()) => {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getTime() >= dayStart(ref).getTime();
};
const seconds = (n) => Math.max(0, Math.floor(Number(n) || 0));

function requiredSeconds(video) {
  const pct = Math.min(Math.max(Number(config.watch.requiredPct) || 0.9, 0.1), 1);
  return Math.max(Number(config.watch.minSessionSeconds) || 10, Math.ceil(Number(video.duration_seconds) * pct));
}

/** Videos the user can watch right now, with their status for today. */
async function listVideos(userId) {
  const rows = await videos.all({ where: { status: 'active' }, orderBy: 'id ASC', limit: 100 });
  const dailyLimit = await settings.getNumber('watch_daily_limit');
  const mine = await sessions.all({ where: { user_id: Number(userId) }, orderBy: 'created_at DESC', limit: 500 });

  const todays = mine.filter((s) => sameDay(s.created_at));
  const completedToday = todays.filter((s) => s.status === 'completed');

  const out = [];
  for (const v of rows) {
    const doneToday = completedToday.filter((s) => Number(s.video_id) === Number(v.id)).length;
    const limit = Math.min(Number(v.daily_limit) || 1, dailyLimit || 1);
    const pending = mine.find((s) => Number(s.video_id) === Number(v.id) && s.status === 'pending');
    out.push({
      id: v.id,
      title: v.title,
      description: v.description,
      video_url: v.video_url,
      duration_seconds: seconds(v.duration_seconds),
      reward: r2(v.reward),
      currency_code: v.currency_code || config.wallet.currency,
      daily_limit: limit,
      completed_today: doneToday,
      status: doneToday >= limit ? 'completed' : pending ? 'in_progress' : 'available',
      session_id: pending ? pending.id : null,
    });
  }
  return {
    videos: out,
    daily: { limit: dailyLimit, completed: completedToday.length, remaining: Math.max(0, (dailyLimit || 0) - completedToday.length) },
  };
}

/** Start (or resume) a watch session for a video. */
async function startSession({ user, videoId, ip, userAgent }) {
  const video = await videos.byId(videoId);
  if (!video || video.status !== 'active') throw Object.assign(new Error('This video is not available'), { status: 404 });

  const dailyLimit = await settings.getNumber('watch_daily_limit');
  const mine = await sessions.all({ where: { user_id: Number(user.id), video_id: Number(video.id) }, orderBy: 'created_at DESC', limit: 200 });
  const todays = mine.filter((s) => sameDay(s.created_at || s.started_at));
  const limit = Math.min(Number(video.daily_limit) || 1, dailyLimit || 1);

  if (todays.filter((s) => s.status === 'completed').length >= limit) {
    throw Object.assign(new Error('You have already completed this video today — try again tomorrow'), { status: 409 });
  }

  const existing = todays.find((s) => s.status === 'pending');
  if (existing) return { session: existing, video, resumed: true };

  const session = await sessions.create({
    user_id: Number(user.id),
    video_id: Number(video.id),
    status: 'pending',
    required_seconds: requiredSeconds(video),
    watched_seconds: 0,
    progress_pct: 0,
    started_at: new Date().toISOString(),
    last_ping_at: new Date().toISOString(),
    reward_amount: r2(video.reward),
    currency_code: video.currency_code || config.wallet.currency,
    client_ip: ip ? String(ip).slice(0, 60) : null,
    user_agent: userAgent ? String(userAgent).slice(0, 300) : null,
  });
  return { session, video, resumed: false };
}

/**
 * Record real watch progress. Progress can only move forward, is capped at the
 * video duration, and cannot exceed the wall-clock time since the session
 * started (which is what stops a "claim instantly" client).
 */
async function recordProgress({ user, sessionId, watchedSeconds, progressPct = null }) {
  const session = await sessions.byId(sessionId);
  if (!session || Number(session.user_id) !== Number(user.id)) {
    throw Object.assign(new Error('Watch session not found'), { status: 404 });
  }
  if (session.status !== 'pending') return { session, locked: true };

  const video = await videos.byId(session.video_id);
  if (!video) throw Object.assign(new Error('Video no longer exists'), { status: 404 });

  const elapsed = Math.floor((Date.now() - new Date(session.started_at).getTime()) / 1000);
  const duration = seconds(video.duration_seconds);
  const reported = seconds(watchedSeconds);
  // Elapsed time is an upper bound; a little slack absorbs network hiccups.
  const ceiling = Math.max(0, Math.min(duration, elapsed + 5));
  const accepted = Math.max(seconds(session.watched_seconds), Math.min(reported, ceiling));

  const pct = progressPct == null
    ? (duration ? Math.min(100, Math.round((accepted / duration) * 1000) / 10) : 0)
    : Math.min(100, Math.max(0, Math.round(Number(progressPct) * 10) / 10));

  const updated = await sessions.update(session.id, {
    watched_seconds: accepted,
    progress_pct: pct,
    last_ping_at: new Date().toISOString(),
  });

  return {
    session: updated,
    video: { id: video.id, title: video.title, duration_seconds: duration, reward: r2(video.reward) },
    required_seconds: Number(session.required_seconds),
    eligible: accepted >= Number(session.required_seconds),
    progress_pct: pct,
    watched_seconds: accepted,
  };
}

/** Validate a session and credit the reward exactly once. */
async function claimReward({ user, sessionId }) {
  const session = await sessions.byId(sessionId);
  if (!session || Number(session.user_id) !== Number(user.id)) {
    throw Object.assign(new Error('Watch session not found'), { status: 404 });
  }
  if (session.status === 'completed') {
    return {
      already_rewarded: true,
      reward: r2(session.reward_amount),
      currency_code: session.currency_code,
      txn_id: session.reward_txn_id,
      message: 'Reward already received for this session.',
    };
  }
  if (session.status !== 'pending') {
    throw Object.assign(new Error('This watch session can no longer be rewarded'), { status: 409 });
  }

  const video = await videos.byId(session.video_id);
  if (!video) throw Object.assign(new Error('Video no longer exists'), { status: 404 });

  const elapsed = Math.floor((Date.now() - new Date(session.started_at).getTime()) / 1000);
  const required = Number(session.required_seconds) || requiredSeconds(video);
  const watched = seconds(session.watched_seconds);

  if (watched < required) {
    throw Object.assign(
      new Error(`Keep watching — ${Math.max(0, required - watched)}s remaining before this reward can be claimed`),
      { status: 400, code: 'INCOMPLETE' },
    );
  }
  if (elapsed + 3 < required) {
    // Reported watch time exceeds real elapsed time => tampered client.
    await sessions.update(session.id, { status: 'failed', completed_at: new Date().toISOString() });
    await ledger.audit({
      action: 'watch.tamper_detected',
      targetType: 'watch_session',
      targetId: session.id,
      detail: `watched=${watched}s elapsed=${elapsed}s required=${required}s`,
    });
    throw Object.assign(new Error('We could not verify this watch session. Please watch the video again.'), { status: 400, code: 'UNVERIFIED' });
  }

  const dailyLimit = await settings.getNumber('watch_daily_limit');
  const mine = await sessions.all({ where: { user_id: Number(user.id) }, orderBy: 'created_at DESC', limit: 500 });
  const completedToday = mine.filter((s) => s.status === 'completed' && sameDay(s.completed_at || s.created_at));
  if (completedToday.length >= dailyLimit) {
    throw Object.assign(new Error(`Daily limit reached (${dailyLimit} videos). Come back tomorrow.`), { status: 429 });
  }
  const perVideoToday = completedToday.filter((s) => Number(s.video_id) === Number(video.id)).length;
  if (perVideoToday >= (Number(video.daily_limit) || 1)) {
    throw Object.assign(new Error('You have already completed this video today'), { status: 409 });
  }

  const reward = r2(video.reward);
  const { transaction, duplicate } = await ledger.credit({
    userId: user.id,
    type: 'WATCH_REWARD',
    amount: reward,
    description: `Watch reward — ${video.title}`.slice(0, 200),
    reference: `session:${session.id}`,
    idempotencyKey: `watch:${session.id}`,
    metadata: { video_id: video.id, session_id: session.id, watched_seconds: watched },
  });

  if (!duplicate) {
    await sessions.update(session.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      verified_at: new Date().toISOString(),
      watched_seconds: watched,
      progress_pct: 100,
      reward_txn_id: transaction.txn_id,
    });
    await users.adjust(user.id, 'watched_count', 1);
    await notify.push(user.id, {
      title: 'Reward Received',
      message: `+ ${transaction.currency_code} ${reward.toFixed(2)} for "${video.title}".`,
      type: 'success',
      link: '#/wallet',
    });
    await maybePayReferralReward(user);
  }

  const fresh = await users.byId(user.id);
  return {
    reward,
    currency_code: transaction.currency_code,
    txn_id: transaction.txn_id,
    transaction,
    duplicate,
    balance: r2(fresh ? fresh.balance : 0),
    message: `Reward Received — + ${transaction.currency_code} ${reward.toFixed(2)}`,
  };
}

/**
 * Referral reward (section 14): credited once, when a referred user completes
 * their first verified watch reward. Never fabricates referrals or rewards.
 */
async function maybePayReferralReward(user) {
  if (!user.referred_by) return null;
  const reward = await settings.getNumber('referral_reward');
  if (!(reward > 0)) return null;

  const rel = await referrals.get({ referred_user_id: Number(user.id) });
  if (!rel || rel.qualified_at) return null;

  const { transaction, duplicate } = await ledger.credit({
    userId: rel.referrer_id,
    type: 'REFERRAL_REWARD',
    amount: reward,
    description: 'Referral reward — referred user completed a watch task',
    reference: `${user.username || user.id}`,
    idempotencyKey: `referral:${user.id}`,
    metadata: { referred_user_id: Number(user.id) },
  });
  if (duplicate) return null;

  await referrals.update(rel.id, {
    qualified_at: new Date().toISOString(),
    commission: r2(Number(rel.commission || 0) + reward),
  });
  await users.adjust(rel.referrer_id, 'referral_earnings', reward);
  await notify.push(rel.referrer_id, {
    title: 'Referral Reward',
    message: `You earned ${transaction.currency_code} ${reward.toFixed(2)} because someone you referred completed a watch task.`,
    type: 'success',
    link: '#/team',
  });
  ws.broadcastAdmins({ type: 'admin_alert', payload: { kind: 'referral_reward', user_id: rel.referrer_id, amount: reward } });
  return transaction;
}

/** Rewards screen data (section 15). */
async function rewardsSummary(user) {
  const s = await settings.getAll();
  const mine = await sessions.all({ where: { user_id: Number(user.id) }, orderBy: 'created_at DESC', limit: 500 });
  const completedToday = mine.filter((x) => x.status === 'completed' && sameDay(x.completed_at || x.created_at)).length;
  const rel = await referrals.get({ referrer_id: Number(user.id) });
  const refCount = await referrals.count({ referrer_id: Number(user.id) });
  const refEarned = r2(user.referral_earnings);

  return {
    currency_code: user.currency_code || config.wallet.currency,
    daily_watch: {
      title: 'Daily Watch Reward',
      progress: completedToday,
      target: Number(s.watch_daily_limit),
      label: `${completedToday} / ${Number(s.watch_daily_limit)}`,
      reward_per_video: (await videos.all({ where: { status: 'active' }, limit: 1 })).map((v) => r2(v.reward))[0] || 0,
    },
    referral: {
      title: 'Referral Reward',
      status: Number(s.referral_reward) > 0 ? 'Available according to referral rules' : 'Not currently available',
      reward: r2(s.referral_reward),
      referrals: refCount,
      earned: refEarned,
      qualified: Boolean(rel && rel.qualified_at),
    },
    bonus: {
      title: 'Bonus',
      status: 'No active bonus',
      amount: 0,
    },
  };
}

/** Home quick stats (section 05) — all values come from backend records. */
async function homeStats(user) {
  const mine = await sessions.all({ where: { user_id: Number(user.id) }, orderBy: 'created_at DESC', limit: 1000 });
  const completed = mine.filter((x) => x.status === 'completed');
  const todayRows = await ledger.history(user.id, { filter: 'earnings', limit: 500 });
  const todayEarnings = r2(todayRows.rows
    .filter((r) => r.status === 'COMPLETED' && sameDay(r.created_at))
    .reduce((s, r) => s + Number(r.amount || 0), 0));
  const totals = await ledger.totals(user.id);

  return {
    today_earnings: todayEarnings,
    total_earnings: totals.total_earned,
    watched: completed.filter((x) => sameDay(x.completed_at || x.created_at)).length,
    watched_total: completed.length,
    available_balance: totals.available,
    pending_balance: totals.pending,
    currency_code: user.currency_code || config.wallet.currency,
    daily: {
      limit: await settings.getNumber('watch_daily_limit'),
      completed_today: completed.filter((x) => sameDay(x.completed_at || x.created_at)).length,
    },
  };
}

module.exports = {
  listVideos, startSession, recordProgress, claimReward, rewardsSummary, homeStats,
  requiredSeconds, maybePayReferralReward,
};
