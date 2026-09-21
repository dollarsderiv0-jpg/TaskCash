-- ============================================================================
-- TaskCash Pro — 0005 currencies and configurable business rules
--
-- This migration contains NO demo users, NO demo balances and NO demo
-- transactions. It only seeds the currency table and the business rules that
-- administrators are expected to tune. Every rule below has a real consumer
-- in the application code or in the money functions.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- currencies — enable more countries by flipping `enabled`, no code change
-- ---------------------------------------------------------------------------
insert into public.currencies (code, name, symbol, minor_unit, min_deposit, min_withdrawal, max_withdrawal, withdrawal_fee, enabled)
values
  ('KES', 'Kenyan Shilling',   'KES', 2, 10,    100,   100000, 0, true),
  ('UGX', 'Ugandan Shilling',  'UGX', 0, 1000,  2000,  400000, 0, false),
  ('TZS', 'Tanzanian Shilling','TZS', 0, 1000,  2000,  400000, 0, false),
  ('RWF', 'Rwandan Franc',     'RWF', 0, 500,   1000,  200000, 0, false),
  ('NGN', 'Nigerian Naira',    'NGN', 2, 500,   1000,  2000000, 0, false),
  ('GHS', 'Ghanaian Cedi',     'GHS', 2, 5,     20,    20000,  0, false),
  ('ZAR', 'South African Rand','ZAR', 2, 20,    50,    50000,  0, false),
  ('USD', 'US Dollar',         '$',   2, 1,     5,     5000,   0, false),
  ('EUR', 'Euro',              '€',   2, 1,     5,     5000,   0, false)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- business rules
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value, type, category, description, is_public) values
  -- rewards ---------------------------------------------------------------
  ('rewards.cooldown_seconds',        '0'::jsonb,   'number',  'rewards',
   'Minimum seconds between two rewarded watches of the same video.', false),
  ('rewards.max_daily_rewarded_sessions', '200'::jsonb, 'number', 'rewards',
   'Platform-wide cap on how many video rewards one user can earn per day.', false),
  ('rewards.payout_currency',         '"KES"'::jsonb, 'string', 'rewards',
   'Default currency used when an administrator creates a new campaign.', false),

  -- referrals -------------------------------------------------------------
  ('referrals.enabled',               'true'::jsonb,    'boolean', 'referrals',
   'Master switch for the referral program.', true),
  ('referrals.qualifying_event',      '"VERIFIED_REGISTRATION"'::jsonb, 'string', 'referrals',
   'Event that turns a pending referral into a qualifying referral. One of VERIFIED_REGISTRATION, KYC_VERIFIED, ELIGIBLE_DEPOSIT, QUALIFYING_TASK.', true),
  ('referrals.level1_rate',           '0.05'::jsonb,    'number',  'referrals',
   'Direct referral commission rate applied to the referee''s eligible deposit (0.05 = 5%).', true),
  ('referrals.level2_rate',           '0'::jsonb,       'number',  'referrals',
   'Second-level referral commission rate. 0 disables level 2.', true),
  ('referrals.signup_bonus',          '0'::jsonb,       'number',  'referrals',
   'Fixed bonus paid to the referrer when a referral qualifies. 0 disables it.', true),
  ('referrals.commission_on_deposit', 'true'::jsonb,    'boolean', 'referrals',
   'Pay referral commission on verified deposits made by a qualifying referral.', false),

  -- deposits --------------------------------------------------------------
  ('deposits.min_amount',             '10'::jsonb,      'number',  'deposits',
   'Minimum deposit accepted, in the wallet currency.', true),
  ('deposits.max_amount',             '150000'::jsonb,  'number',  'deposits',
   'Maximum single deposit accepted, in the wallet currency.', true),

  -- withdrawals -----------------------------------------------------------
  ('withdrawals.require_verified_kyc', 'false'::jsonb,  'boolean', 'withdrawals',
   'Require a VERIFIED KYC status before a withdrawal can be requested.', true),
  ('withdrawals.min_account_age_hours','0'::jsonb,      'number',  'withdrawals',
   'Minimum account age in hours before a withdrawal can be requested.', true),
  ('withdrawals.max_pending_requests', '1'::jsonb,      'number',  'withdrawals',
   'How many withdrawals a user may have in flight at one time.', true),
  ('withdrawals.daily_limit',          '50000'::jsonb,  'number',  'withdrawals',
   'Rolling 24h withdrawal volume limit per user, in the wallet currency.', true),
  ('withdrawals.high_value_threshold', '10000'::jsonb,  'number',  'withdrawals',
   'Amount above which an administrator must re-confirm before approving.', false),
  ('withdrawals.require_2fa_above_threshold', 'false'::jsonb, 'boolean', 'withdrawals',
   'Require a second authentication factor for approvals above the high-value threshold.', false),

  -- security & fraud ------------------------------------------------------
  ('security.require_email_verified_to_earn', 'false'::jsonb, 'boolean', 'security',
   'Block earning activities until the user has confirmed their email address.', false),
  ('fraud.max_rewarded_sessions_per_hour', '40'::jsonb, 'number', 'fraud',
   'Rewarded watch sessions allowed per user per hour before the session is refused.', false),
  ('fraud.review_score_threshold',    '40'::jsonb, 'number', 'fraud',
   'Rolling risk score at which a user is placed into the review queue.', false),
  ('fraud.restrict_score_threshold',  '70'::jsonb, 'number', 'fraud',
   'Rolling risk score at which a user is restricted from withdrawals.', false),
  ('fraud.suspend_score_threshold',   '90'::jsonb, 'number', 'fraud',
   'Rolling risk score at which a user is suspended from earning.', false),
  ('fraud.max_accounts_per_ip',       '5'::jsonb,  'number', 'fraud',
   'Registrations allowed from a single IP hash per day before review is triggered.', false),

  -- payments --------------------------------------------------------------
  ('payments.provider',               '"SASAPAY"'::jsonb, 'string', 'payments',
   'Active payment provider. SasaPay is the only supported disbursement provider.', false),

  -- platform / legal placeholders (filled in by the business owner) -------
  ('platform.legal_name',             '""'::jsonb, 'string', 'legal',
   'Registered legal entity operating TaskCash Pro. Leave empty until supplied — the site will not invent one.', true),
  ('platform.registration_details',   '""'::jsonb, 'string', 'legal',
   'Company registration / permit details exactly as supplied by the business owner.', true),
  ('platform.business_address',       '""'::jsonb, 'string', 'legal',
   'Registered business address.', true),
  ('platform.support_email',          '""'::jsonb, 'string', 'legal',
   'Support email shown on the contact page.', true),
  ('platform.support_phone',          '""'::jsonb, 'string', 'legal',
   'Support phone number shown on the contact page.', true),
  ('platform.privacy_contact',        '""'::jsonb, 'string', 'legal',
   'Contact for privacy and data protection requests.', true),
  ('platform.data_protection_note',   '""'::jsonb, 'string', 'legal',
   'Data protection / regulator details where applicable.', true),
  ('platform.payment_provider_details','""'::jsonb, 'string', 'legal',
   'Payment provider disclosure details supplied by the business owner.', true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Promoting the first administrator is an explicit, manual operation.
--
--   update public.profiles
--      set role = 'SUPER_ADMIN'
--    where email = 'owner@yourdomain.com';
--
-- It is intentionally not automated here: no seeded admin account, and no
-- default password, exists in this project.
-- ---------------------------------------------------------------------------
