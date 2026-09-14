/** Shared helpers: money math, codes, async wrapper, client IP. */
const crypto = require('crypto');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function referralCode(seed) {
  const base = crypto.randomBytes(5).toString('hex').toUpperCase();
  const prefix = String(seed || 'TC').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || 'TC';
  return (prefix + base).slice(0, 10);
}

function token(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function txnRef(prefix) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

/** Normalises Kenyan numbers to 2547XXXXXXXX / 2541XXXXXXXX for Daraja. */
function toMpesaFormat(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (/^254\d{9}$/.test(digits)) return digits;
  if (/^0\d{9}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^7\d{8}$/.test(digits) || /^1\d{8}$/.test(digits)) return `254${digits}`;
  return digits;
}
function isValidKenyanPhone(input) {
  return /^254(7|1)\d{8}$/.test(toMpesaFormat(input));
}

/** Wraps async route handlers so rejections hit the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

const page = (rows, req) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  return { rows, limit, offset };
};
const slice = (rows, { limit, offset }) => rows.slice(offset, offset + limit);

module.exports = { r2, referralCode, token, txnRef, toMpesaFormat, isValidKenyanPhone, wrap, clientIp, page, slice };
