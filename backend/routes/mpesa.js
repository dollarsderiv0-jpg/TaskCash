const express = require('express');
const { wrap } = require('../lib/helpers');
const { processCallback } = require('../services/mpesa-webhook');

const router = express.Router();

/**
 * Daraja posts here after STK completes. CSRF-exempt (server-to-server);
 * production hardening: optionally verify via OAuth transaction query API.
 */
router.post('/callback', wrap(async (req, res) => {
  try {
    const result = await processCallback(req.body);
    console.log('[mpesa] callback processed:', JSON.stringify(result));
  } catch (e) {
    console.warn('[mpesa] callback error:', e.message);
  }
  // Daraja always expects a 200 so it doesn't retry forever
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}));

module.exports = router;
