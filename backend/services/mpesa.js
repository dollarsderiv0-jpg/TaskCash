/**
 * M-Pesa Daraja service (STK Push / Lipa na M-Pesa Online).
 *
 * Live mode  : set MPESA_APP_KEY + MPESA_APP_SECRET (+ CALLBACK_URL) in .env
 * Demo mode  : no keys — STK "push" is simulated; callback auto-fires after a
 *              few seconds so the whole deposit UX is testable locally.
 */
const axios = require('axios');
const config = require('../config');
const { txnRef } = require('../lib/helpers');

const BASE = config.mpesa.env === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

let cachedToken = null;

async function getAccessToken() {
  if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.token;
  const auth = Buffer.from(`${config.mpesa.key}:${config.mpesa.secret}`).toString('base64');
  const { data } = await axios.get(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
    timeout: 15000,
  });
  cachedToken = { token: data.access_token, expires: Date.now() + (data.expires_in - 30) * 1000 };
  return cachedToken.token;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function password() {
  return Buffer.from(`${config.mpesa.shortcode}${config.mpesa.passkey}${timestamp()}`).toString('base64');
}

/**
 * Initiates an STK push. Returns { providerRef, demo }.
 * In demo mode (no Daraja keys) it resolves immediately with a fake ref.
 */
async function stkPush({ phone, amount, accountRef }) {
  const ref = txnRef('TC');

  if (!config.mpesa.enabled) {
    return { providerRef: `DEMO${ref}`, demo: true };
  }

  const token = await getAccessToken();
  const cbBase = config.mpesa.baseUrl || config.appUrl;
  const payload = {
    BusinessShortCode: config.mpesa.shortcode,
    Password: password(),
    Timestamp: timestamp(),
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(Number(amount)),
    PartyA: phone,
    PartyB: config.mpesa.shortcode,
    PhoneNumber: phone,
    CallBackURL: `${cbBase}/api/mpesa/callback`,
    AccountReference: String(accountRef || 'TaskCash').slice(0, 12),
    TransactionDesc: 'TaskCash deposit',
  };
  const { data } = await axios.post(`${BASE}/mpesa/stkpush/v1/processrequest`, payload, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 20000,
  });
  if (data.ResponseCode !== '0') {
    throw new Error(data.ResponseDescription || 'STK push failed');
  }
  return { providerRef: data.CheckoutRequestID, demo: false };
}

/** Simulates a Daraja callback payload (demo mode only). */
function demoCallbackBody(deposit) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: `DEMO-${deposit.id}`,
        CheckoutRequestID: deposit.provider_ref,
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: Number(deposit.amount) },
            { Name: 'MpesaReceiptNumber', Value: `R${Date.now().toString(36).toUpperCase()}` },
            { Name: 'PhoneNumber', Value: deposit.phone },
          ],
        },
      },
    },
  };
}

module.exports = { stkPush, demoCallbackBody, getAccessToken, BASE };
