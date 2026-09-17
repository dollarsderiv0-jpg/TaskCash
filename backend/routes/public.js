/**
 * Public endpoints — safe to read before authentication.
 * No credentials, no balances, no user data.
 */
const express = require('express');
const { wrap } = require('../lib/helpers');
const settings = require('../services/settings');

const router = express.Router();

/** Splash / login / deposit screens read platform rules from here. */
router.get('/config', wrap(async (_req, res) => {
  res.json(await settings.publicConfig());
}));

/** Liveness probe for deployments. */
router.get('/health', wrap(async (_req, res) => {
  const payments = require('../services/payments');
  res.json({ ok: true, brand: settings.DEFAULTS.brand_name, payment_provider: payments.describe().id });
}));

module.exports = router;
