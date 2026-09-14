/** KYC verification service (ID upload simulated as data-URL/URL storage). */
const { Table } = require('../db');
const users = new Table('users');

function normaliseDocs(body) {
  const docs = {
    id_front: String(body.id_front || '').slice(0, 500000),
    id_back: String(body.id_back || '').slice(0, 500000),
    selfie: String(body.selfie || '').slice(0, 500000),
  };
  if (!docs.id_front) throw new Error('ID front image is required');
  return docs;
}

async function submit(userId, body) {
  const docs = normaliseDocs(body);
  const user = await users.byId(userId);
  if (!user) throw new Error('User not found');
  if (user.kyc_status === 'pending') throw new Error('Verification already under review');

  await users.update(userId, { kyc_status: 'pending', kyc_docs: JSON.stringify(docs) });
  return { status: 'pending' };
}

async function review(userId, decision, reviewerId) {
  const status = decision === 'approve' ? 'verified' : 'unverified';
  const user = await users.byId(userId);
  if (!user) throw new Error('User not found');
  await users.update(userId, { kyc_status: status });
  return { user_id: userId, kyc_status: status, reviewed_by: reviewerId || null };
}

module.exports = { submit, review };
