/** M-Pesa Daraja callback processing (shared by webhook route + demo mode). */
const { Table } = require('../db');
const config = require('../config');
const { r2 } = require('../lib/helpers');
const { formatMoney } = require('../lib/money');
const ws = require('../lib/ws');

const deposits = new Table('deposits');
const users = new Table('users');
const notifications = new Table('notifications');

/**
 * Processes a Daraja STK callback body. Idempotent: once a deposit is
 * approved/rejected it is never re-processed.
 */
async function processCallback(body) {
  const cb = body && body.Body && body.Body.stkCallback;
  if (!cb) throw new Error('Malformed callback');

  const checkoutId = cb.CheckoutRequestID;
  const deposit = (await deposits.all({ where: { provider_ref: checkoutId }, limit: 1 }))[0];
  if (!deposit) throw new Error(`No deposit for CheckoutRequestID ${checkoutId}`);
  if (deposit.status !== 'pending') return { idempotent: true };

  if (Number(cb.ResultCode) === 0) {
    const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
    const get = (name) => { const it = items.find((i) => i.Name === name); return it ? it.Value : null; };
    const receipt = get('MpesaReceiptNumber') || 'N/A';

    await deposits.update(deposit.id, {
      status: 'approved',
      reference: String(receipt).slice(0, 40),
    });
    await users.adjust(deposit.user_id, 'balance', r2(deposit.amount));
    await notifications.create({
      user_id: deposit.user_id, type: 'success',
      title: 'Deposit confirmed ✅',
      message: `${formatMoney(r2(deposit.amount), deposit.currency_code)} has been added to your balance. Receipt ${receipt}.`,
    });
    ws.broadcastAdmins({ type: 'admin_alert', payload: { kind: 'deposit', id: deposit.id, amount: deposit.amount } });
    return { status: 'approved' };
  }

  await deposits.update(deposit.id, {
    status: 'rejected',
    failure_reason: String(cb.ResultDesc || 'Cancelled by user').slice(0, 300),
  });
  await notifications.create({
    user_id: deposit.user_id, type: 'danger',
    title: 'Deposit failed',
    message: String(cb.ResultDesc || 'The M-Pesa payment did not go through.').slice(0, 200),
  });
  return { status: 'rejected' };
}

module.exports = { processCallback };
