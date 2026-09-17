/**
 * Mailer. Uses nodemailer SMTP when configured; otherwise logs to console
 * (sandbox mode) so the reset flow still works without infrastructure. Reset
 * links are surfaced in the API response only outside production.
 */
const config = require('../config');

let transporter = null;
try {
  if (config.smtp.host) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
} catch {
  transporter = null;
}

async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    console.log(`[mail:demo] to=${to} subject="${subject}"`);
    return { demo: true };
  }
  await transporter.sendMail({ from: config.smtp.from, to, subject, text, html });
  return { sent: true };
}

function layout(title, body) {
  return `<!doctype html><html><body style="margin:0;background:#F7F7FA;font-family:Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;color:#17131D">
    <div style="font-size:22px;font-weight:700;color:#5421A6;margin-bottom:16px">${config.brand}</div>
    <h2 style="color:#32105F;margin:0 0 12px">${title}</h2>
    <div style="font-size:15px;line-height:1.6;color:#17131D">${body}</div>
    <p style="margin-top:28px;font-size:12px;color:#78909c">${config.brand} · Rewards come only from verified watch activity and published referral rules. Deposits are never investment returns.</p>
  </div></body></html>`;
}

function sendVerificationMail(user, url) {
  return sendMail({
    to: user.email,
    subject: `Verify your ${config.brand} account`,
    html: layout('Confirm your email',
      `<p>Hi ${user.fullname || user.username},</p>
       <p>Tap the button below to verify your email address.</p>
       <p><a href="${url}" style="display:inline-block;background:#5421A6;color:#ffffff;font-weight:700;padding:12px 22px;border-radius:10px;text-decoration:none">Verify email</a></p>
       <p style="font-size:13px">Or copy this link: ${url}</p>`),
  });
}

function sendResetMail(user, url) {
  return sendMail({
    to: user.email,
    subject: `Reset your ${config.brand} password`,
    html: layout('Password reset',
      `<p>Hi ${user.fullname || user.username},</p>
       <p>We received a request to reset your password. This link expires in 1 hour.</p>
       <p><a href="${url}" style="display:inline-block;background:#5421A6;color:#ffffff;font-weight:700;padding:12px 22px;border-radius:10px;text-decoration:none">Reset password</a></p>
       <p style="font-size:13px">Or copy this link: ${url}</p>
       <p style="font-size:13px">If you didn't request this, you can safely ignore this email.</p>`),
  });
}

module.exports = { sendMail, sendVerificationMail, sendResetMail };
