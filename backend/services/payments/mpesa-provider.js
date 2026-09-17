/**
 * M-Pesa (Safaricom Daraja) provider — the live provider.
 *
 *   deposits    : STK Push (Lipa na M-Pesa Online) + STK Push Query for verification
 *   withdrawals : B2C Payment Request + Transaction Status for verification
 *   callback    : /api/mpesa/callback receives STK results and B2C results
 *
 * Credentials come from server-side env only:
 *   MPESA_APP_KEY, MPESA_APP_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY,
 *   MPESA_ENV (sandbox|production), MPESA_BASE_URL (tunnels),
 *   MPESA_B2C_SHORTCODE, MPESA_B2C_INITIATOR, MPESA_B2C_SECURITY_CREDENTIAL
 *
 * Nothing in this file is exposed to the browser, and it never fabricates a
 * receipt: a deposit is only marked successful from a callback / query result.
 */
const axios = require('axios');
const crypto = require('crypto');
const config = require('../../config');
const { toMpesaFormat } = require('../../lib/helpers');
const { PaymentError, PaymentNotConfiguredError } = require('./provider');

const BASE = config.mpesa.env === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

let cachedToken = null;

async function getAccessToken() {
  if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.token;
  if (!config.mpesa.enabled) throw new PaymentNotConfiguredError('M-Pesa credentials are not configured');
  const auth = Buffer.from(`${config.mpesa.key}:${config.mpesa.secret}`).toString('base64');
  try {
    const { data } = await axios.get(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
      timeout: 15000,
    });
    cachedToken = { token: data.access_token, expires: Date.now() + (Number(data.expires_in) - 30) * 1000 };
    return cachedToken.token;
  } catch (e) {
    throw new PaymentError(`M-Pesa authentication failed: ${e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message}`);
  }
}

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const stkPassword = () => Buffer.from(`${config.mpesa.shortcode}${config.mpesa.passkey}${timestamp()}`).toString('base64');
const callbackBase = () => config.mpesa.baseUrl || config.appUrl;

// ── Deposits (STK Push) ─────────────────────────────────────
async function createDeposit({ deposit, phone, amount }) {
  if (!config.mpesa.enabled) throw new PaymentNotConfiguredError('M-Pesa credentials are not configured');
  if (!config.mpesa.passkey) throw new PaymentNotConfiguredError('M-Pesa passkey is not configured');

  const token = await getAccessToken();
  const payload = {
    BusinessShortCode: config.mpesa.shortcode,
    Password: stkPassword(),
    Timestamp: timestamp(),
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(Number(amount)),          // Daraja requires whole KES
    PartyA: toMpesaFormat(phone),
    PartyB: config.mpesa.shortcode,
    PhoneNumber: toMpesaFormat(phone),
    CallBackURL: config.mpesa.callbackUrl || `${callbackBase()}/api/mpesa/callback`,
    AccountReference: String(config.payments.accountRef || 'WATCHREWARDS').slice(0, 12),
    TransactionDesc: 'WATCHREWARDS deposit',
  };

  try {
    const { data } = await axios.post(`${BASE}/mpesa/stkpush/v1/processrequest`, payload, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000,
    });
    if (String(data.ResponseCode) !== '0') {
      throw new PaymentError(data.ResponseDescription || 'STK push was rejected by M-Pesa');
    }
    return {
      providerRef: data.CheckoutRequestID,
      status: 'PENDING',
      sandbox: false,
      message: 'Check your phone and enter your M-Pesa PIN to complete the payment.',
    };
  } catch (e) {
    if (e instanceof PaymentError) throw e;
    throw new PaymentError(`M-Pesa request failed: ${e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message}`);
  }
}

/** STK Push Query — the authoritative status for a pending collection. */
async function verifyDeposit({ deposit }) {
  if (!config.mpesa.enabled) throw new PaymentNotConfiguredError();
  if (deposit.payment_reference) {
    return { status: 'SUCCESSFUL', reference: deposit.payment_reference, detail: 'Confirmed by M-Pesa callback' };
  }
  if (!deposit.provider_ref) return { status: 'PENDING', detail: 'No provider reference yet' };

  const token = await getAccessToken();
  try {
    const { data } = await axios.post(`${BASE}/mpesa/stkpushquery/v1/query`, {
      BusinessShortCode: config.mpesa.shortcode,
      Password: stkPassword(),
      Timestamp: timestamp(),
      CheckoutRequestID: deposit.provider_ref,
    }, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });

    const code = Number(data.ResultCode);
    if (code === 0) {
      const receipt = data.ResultParameters?.ResultParameter?.find?.((p) => p.Key === 'MpesaReceiptNumber')?.Value;
      return { status: 'SUCCESSFUL', reference: receipt || null, detail: data.ResultDesc || 'Payment confirmed' };
    }
    // 1032 = cancelled by user, 1037 = timeout/no response yet
    if (code === 1037 || code === 500) return { status: 'PENDING', detail: data.ResultDesc || 'Still processing' };
    return { status: 'FAILED', detail: data.ResultDesc || 'Payment was not completed' };
  } catch (e) {
    // Daraja returns an error while the request is still in flight — stay pending.
    const detail = e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
    if (/processing|pending|500\.001\.2001/i.test(detail)) return { status: 'PENDING', detail };
    throw new PaymentError(`M-Pesa status check failed: ${detail}`);
  }
}

// ── Withdrawals (B2C) ───────────────────────────────────────
function b2cReady() { return config.mpesa.enabled && config.mpesa.b2c.enabled; }

async function createWithdrawal({ withdrawal, phone, amount }) {
  if (!b2cReady()) {
    // The platform can still accept the request — it stays pending and is
    // processed manually once B2C credentials are configured. Nothing here
    // claims the payout happened.
    return {
      providerRef: null,
      status: 'PENDING',
      sandbox: false,
      message: 'Payout queued for processing. You will be notified once M-Pesa confirms the transfer.',
    };
  }
  const token = await getAccessToken();
  const b2c = config.mpesa.b2c;
  const payload = {
    InitiatorName: b2c.initiatorName,
    SecurityCredential: b2c.securityCredential,
    CommandID: b2c.commandId,
    Amount: Math.round(Number(amount)),
    PartyA: b2c.shortcode,
    PartyB: toMpesaFormat(phone),
    Remarks: `WATCHREWARDS payout ${withdrawal.request_id}`.slice(0, 100),
    QueueTimeOutURL: b2c.timeoutUrl || `${callbackBase()}/api/mpesa/callback`,
    ResultURL: b2c.resultUrl || `${callbackBase()}/api/mpesa/callback`,
    Occasion: String(withdrawal.request_id).slice(0, 20),
  };

  try {
    const { data } = await axios.post(`${BASE}/mpesa/b2c/v1/paymentrequest`, payload, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 25000,
    });
    if (String(data.ResponseCode) !== '0') {
      throw new PaymentError(data.ResponseDescription || 'M-Pesa payout was rejected');
    }
    return {
      providerRef: data.ConversationID,
      status: 'PROCESSING',
      sandbox: false,
      message: 'Payout submitted to M-Pesa — confirmation is pending.',
    };
  } catch (e) {
    if (e instanceof PaymentError) throw e;
    throw new PaymentError(`M-Pesa payout failed: ${e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message}`);
  }
}

async function verifyWithdrawal({ withdrawal }) {
  if (withdrawal.receipt) return { status: 'COMPLETED', reference: withdrawal.receipt, detail: 'Confirmed by M-Pesa callback' };
  if (!withdrawal.provider_ref || !config.mpesa.enabled) {
    return { status: withdrawal.status === 'processing' ? 'PROCESSING' : 'PENDING', detail: 'Awaiting M-Pesa confirmation' };
  }
  const token = await getAccessToken();
  try {
    const { data } = await axios.post(`${BASE}/mpesa/transactionstatus/v1/query`, {
      Initiator: config.mpesa.b2c.initiatorName,
      SecurityCredential: config.mpesa.b2c.securityCredential,
      CommandID: 'TransactionStatusQuery',
      TransactionID: withdrawal.provider_ref,
      PartyA: config.mpesa.b2c.shortcode || config.mpesa.shortcode,
      IdentifierType: '4',
      ResultURL: config.mpesa.b2c.resultUrl || `${callbackBase()}/api/mpesa/callback`,
      QueueTimeOutURL: config.mpesa.b2c.timeoutUrl || `${callbackBase()}/api/mpesa/callback`,
      Remarks: `Status ${withdrawal.request_id}`.slice(0, 100),
      Occasion: String(withdrawal.request_id).slice(0, 20),
    }, { headers: { Authorization: `Bearer ${token}` }, timeout: 25000 });

    if (String(data.ResponseCode) !== '0') {
      return { status: 'PENDING', detail: data.ResponseDescription || 'Status check not accepted yet' };
    }
    return { status: 'PROCESSING', detail: 'M-Pesa is still processing this payout' };
  } catch (e) {
    const detail = e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
    return { status: 'PENDING', detail };
  }
}

// ── Callback parsing (STK results + B2C results) ────────────
function handleCallback(body) {
  const stk = body && body.Body && body.Body.stkCallback;
  if (stk) {
    const items = (stk.CallbackMetadata && stk.CallbackMetadata.Item) || [];
    const get = (name) => { const it = items.find((i) => i.Name === name); return it ? it.Value : null; };
    return {
      kind: 'deposit',
      providerRef: stk.CheckoutRequestID,
      result: Number(stk.ResultCode) === 0 ? 'SUCCESS' : 'FAILED',
      reference: get('MpesaReceiptNumber') ? String(get('MpesaReceiptNumber')) : null,
      amount: get('Amount') != null ? Number(get('Amount')) : null,
      phone: get('PhoneNumber') ? String(get('PhoneNumber')) : null,
      detail: stk.ResultDesc || null,
      raw: body,
    };
  }

  const result = body && (body.Result || (body.Body && body.Body.Result));
  if (result) {
    const params = result.ResultParameters && result.ResultParameters.ResultParameter;
    const pick = (key) => (Array.isArray(params) ? (params.find((p) => p.Key === key) || {}).Value : undefined);
    return {
      kind: 'withdrawal',
      providerRef: pick('TransactionID') || result.ConversationID || body.ConversationID || null,
      result: Number(result.ResultCode) === 0 ? 'SUCCESS' : 'FAILED',
      reference: pick('TransactionReceipt') || null,
      amount: pick('TransactionAmount') != null ? Number(pick('TransactionAmount')) : null,
      phone: pick('DebitPartyName') || null,
      detail: result.ResultDesc || null,
      raw: body,
    };
  }

  throw new PaymentError('Unrecognised payment callback payload', 400);
}

/** Idempotency key so a replayed Daraja callback can never credit twice. */
const callbackKey = (kind, providerRef) => `callback:${kind}:${providerRef}`;

/** Stable hash used to gate duplicate sandbox requests in development. */
const fingerprint = (parts) => crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);

module.exports = {
  id: 'mpesa',
  label: 'M-Pesa (Daraja)',
  get live() { return Boolean(config.mpesa.enabled); },
  get mode() { return config.mpesa.env === 'production' ? 'live' : 'sandbox-credentials'; },
  canPayout: b2cReady,
  createDeposit, verifyDeposit, createWithdrawal, verifyWithdrawal, handleCallback,
  callbackKey, fingerprint, getAccessToken, BASE,
};
