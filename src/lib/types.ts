/**
 * Domain types. These mirror the Postgres schema in supabase/migrations.
 * Keep them in sync — the ledger is only trustworthy if its TypeScript view
 * is accurate.
 */

export const TRANSACTION_TYPES = [
  "DEPOSIT",
  "VIDEO_REWARD",
  "TASK_REWARD",
  "REFERRAL_REWARD",
  "WITHDRAWAL_HOLD",
  "WITHDRAWAL",
  "WITHDRAWAL_FEE",
  "WITHDRAWAL_RELEASE",
  "REFUND",
  "REVERSAL",
  "ADMIN_ADJUSTMENT",
  // Buying a package: a real debit out of the available balance. It is neither a
  // deposit nor a withdrawal, and must not be lumped in with either — a user
  // reading their statement has to be able to see that this one was a purchase.
  "PACKAGE_PURCHASE",
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_STATUSES = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "REJECTED",
  "CANCELLED",
  "REVERSED",
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const WITHDRAWAL_STATUSES = [
  "PENDING_ADMIN_APPROVAL",
  "APPROVED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "REJECTED",
  "CANCELLED",
  "REVERSED",
] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

export const DEPOSIT_STATUSES = TRANSACTION_STATUSES;
export type DepositStatus = TransactionStatus;

export const VIDEO_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "EXPIRED", "COMPLETED", "SUSPENDED"] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export const WATCH_SESSION_STATUSES = [
  "STARTED",
  "WATCHING",
  "COMPLETED",
  "REWARDED",
  "EXPIRED",
  "SUSPENDED",
  "REJECTED",
] as const;
export type WatchSessionStatus = (typeof WATCH_SESSION_STATUSES)[number];

export const RISK_STATUSES = ["NORMAL", "REVIEW", "RESTRICTED", "SUSPENDED"] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export const KYC_STATUSES = [
  "NOT_STARTED",
  "PENDING",
  "VERIFIED",
  "REJECTED",
  "REQUIRES_REVIEW",
] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const USER_STATUSES = ["PENDING", "ACTIVE", "RESTRICTED", "SUSPENDED", "CLOSED"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export type UserRole = "USER" | "ADMIN" | "SUPER_ADMIN";

export type Profile = {
  id: string;
  auth_user_id: string;
  full_name: string;
  email: string;
  phone: string;
  country: string;
  currency: string;
  referral_code: string;
  referred_by: string | null;
  status: UserStatus;
  kyc_status: KycStatus;
  role: UserRole;
  risk_status: RiskStatus;
  risk_score: number;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  last_login_at: string | null;
  /**
   * When this account first got the app on a device, or null when nothing is
   * recorded. Set by `record_app_install()` (migration 0018); it decides whether
   * the wallet screen shows the withdrawal limits. Optional because it is absent
   * on a database that predates 0018, and "absent" must read as "not installed".
   */
  app_downloaded_at?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type WalletStatus = "ACTIVE" | "FROZEN" | "CLOSED";

export type Wallet = {
  id: string;
  user_id: string;
  currency: string;
  available_balance: number;
  locked_balance: number;
  status: WalletStatus;
  frozen_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type WalletTransaction = {
  id: string;
  user_id: string;
  wallet_id: string;
  type: TransactionType;
  amount: number;
  currency: string;
  status: TransactionStatus;
  direction: "CREDIT" | "DEBIT";
  available_delta: number;
  locked_delta: number;
  balance_after: number;
  reference: string;
  external_reference: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  source: string;
  created_at: string;
  completed_at: string | null;
};

export type Deposit = {
  id: string;
  user_id: string;
  wallet_id: string;
  amount: number;
  currency: string;
  phone: string;
  provider: string;
  provider_transaction_id: string | null;
  merchant_reference: string;
  provider_reference: string | null;
  status: DepositStatus;
  failure_reason: string | null;
  /**
   * Safaricom's own identifiers and result, for reconciliation. Populated on
   * M-Pesa deposits only; null for other providers and until the provider has
   * actually said something. `checkout_request_id` and `mpesa_receipt_number`
   * are generated columns over `provider_reference` /`provider_transaction_id`,
   * so they can never disagree with those fields.
   */
  merchant_request_id: string | null;
  checkout_request_id: string | null;
  mpesa_receipt_number: string | null;
  result_code: string | null;
  result_description: string | null;
  updated_at: string;
  callback_payload: Record<string, unknown> | null;
  verified_at: string | null;
  wallet_transaction_id: string | null;
  created_at: string;
  completed_at: string | null;
  /**
   * Set when this deposit is payment for a package rather than a wallet top-up
   * (migration 0019). The amount is then the tier's price, and settlement
   * activates it.
   *
   * `package_activated_at` is the proof that the activation actually happened:
   * COMPLETED + a `package_id` + a NULL `package_activated_at` is a payment whose
   * credit landed but whose package has not been activated yet, which is the
   * state a crash between the two leaves and the state settlement repairs.
   */
  package_id: string | null;
  package_activated_at: string | null;
  package_purchase_id: string | null;
};

export type Withdrawal = {
  id: string;
  user_id: string;
  wallet_id: string;
  amount: number;
  fee: number;
  net_amount: number;
  currency: string;
  phone: string;
  status: WithdrawalStatus;
  risk_score: number;
  admin_id: string | null;
  admin_approved_at: string | null;
  admin_rejected_at: string | null;
  rejection_reason: string | null;
  provider: string;
  provider_transaction_id: string | null;
  provider_reference: string | null;
  provider_request: Record<string, unknown> | null;
  provider_response: Record<string, unknown> | null;
  failure_reason: string | null;
  requested_at: string;
  completed_at: string | null;
  created_at: string;
};

export type VideoCampaign = {
  id: string;
  name: string;
  description: string | null;
  advertiser: string | null;
  budget: number;
  spent: number;
  reward_per_view: number;
  max_views: number | null;
  total_views: number;
  start_at: string | null;
  end_at: string | null;
  status: VideoStatus;
  created_at: string;
  updated_at: string;
};

/*
  Advertisements — a display-only sponsored gallery.

  There is deliberately no reward field: viewing an ad pays nobody. Earning is
  the video campaign system's job, and this type has no shape for money on
  purpose so a future change cannot quietly turn a picture into a payout.
*/
export const AD_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type AdvertisementStatus = (typeof AD_STATUSES)[number];

export const AD_CATEGORIES = [
  "COMPANY_REGISTRATION",
  "DEPOSITS",
  "WITHDRAWALS",
  "PAYMENTS",
  "OTHER",
] as const;
export type AdvertisementCategory = (typeof AD_CATEGORIES)[number];

export type Advertisement = {
  id: string;
  title: string;
  description: string | null;
  advertiser: string | null;
  image_url: string;
  link_url: string | null;
  alt_text: string | null;
  category: AdvertisementCategory;
  sort_order: number;
  status: AdvertisementStatus;
  starts_at: string | null;
  ends_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/*
  Company images — the pictures of the companies behind the platform, shown on
  the public landing page and on the signed-in dashboard.

  Display only, like an advertisement: there is no reward field because looking at
  a company picture pays nobody. `storage_path` is present so that deleting a row
  can also delete the object it uploaded, rather than leaving it in the bucket
  forever.
*/
export const COMPANY_IMAGE_STATUSES = ["ACTIVE", "HIDDEN"] as const;
export type CompanyImageStatus = (typeof COMPANY_IMAGE_STATUSES)[number];

export type CompanyImage = {
  id: string;
  name: string;
  caption: string | null;
  image_url: string;
  storage_path: string | null;
  link_url: string | null;
  sort_order: number;
  status: CompanyImageStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/* -------------------------------------------------------------------------- */
/* Packages — operator-defined paid earning tiers                             */
/* -------------------------------------------------------------------------- */

export const PACKAGE_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];

export const PACKAGE_STATUS_LABELS: Record<PackageStatus, string> = {
  DRAFT: "Draft",
  ACTIVE: "Active",
  PAUSED: "Paused",
  ARCHIVED: "Archived",
};

export function packageStatusLabel(status: string | null | undefined): string {
  if (!status) return "Unknown";
  return PACKAGE_STATUS_LABELS[status as PackageStatus] ?? status;
}

/**
 * A tier a user buys out of their own wallet. `daily_earning_cap` is the most it
 * can pay that user in one calendar day — the figure the countdown counts down to.
 */
export type Package = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  daily_earning_cap: number;
  /**
   * The most one purchase can ever pay, or null for no ceiling. Null and 0 are
   * NOT interchangeable: 0 is rejected by the database outright, precisely so a
   * tier cannot be sold that is allowed to pay nothing.
   */
  lifetime_earning_cap: number | null;
  /** How long a purchase stays earnable, or null when it never lapses. */
  duration_days: number | null;
  status: PackageStatus;
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type UserPackageStatus = "ACTIVE" | "EXPIRED" | "REVOKED";

export type UserPackage = {
  id: string;
  user_id: string;
  package_id: string;
  price_paid: number;
  currency: string;
  /** Snapshot of the terms at the moment of sale; see migration 0014. */
  daily_earning_cap: number;
  lifetime_earning_cap: number | null;
  purchase_transaction_id: string | null;
  purchase_reference: string;
  status: UserPackageStatus;
  purchased_at: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * A package as the buyer sees it: the tier, whether they hold it, and how much
 * of today's allowance is left. `resetsAt` is the instant the countdown targets.
 */
export type PackageWithUsage = Package & {
  owned: boolean;
  purchasedAt: string | null;
  earnedToday: number;
  remainingToday: number;
  /** Null when the user does not hold the package (nothing to count down to). */
  resetsAt: string | null;
  videoCount: number;
  /** Earned under the current purchase, for the lifetime ceiling. */
  earnedTotal: number;
  /** Null for a tier with no ceiling, which is not the same as 0 remaining. */
  lifetimeRemaining: number | null;
  /** When the current purchase lapses, or null when it does not. */
  expiresAt: string | null;
};

export type Video = {
  id: string;
  campaign_id: string | null;
  title: string;
  description: string | null;
  video_url: string;
  thumbnail_url: string | null;
  duration_seconds: number;
  required_watch_seconds: number;
  reward_amount: number;
  currency: string;
  daily_limit: number;
  total_view_limit: number | null;
  total_views: number;
  status: VideoStatus;
  created_at: string;
  updated_at: string;
};

export type WatchSession = {
  id: string;
  user_id: string;
  video_id: string;
  session_token: string;
  status: WatchSessionStatus;
  started_at: string;
  last_activity_at: string;
  completed_at: string | null;
  rewarded_at: string | null;
  watched_seconds: number;
  required_watch_seconds: number;
  reward_amount: number | null;
  reward_transaction_id: string | null;
  reward_reference: string | null;
  reject_reason: string | null;
};

export type Referral = {
  id: string;
  referrer_id: string;
  referred_user_id: string;
  referral_code: string;
  level: number;
  qualifying_event: string | null;
  status: "PENDING" | "QUALIFIED" | "REJECTED";
  created_at: string;
  qualified_at: string | null;
};

export type ReferralCommission = {
  id: string;
  referrer_id: string;
  referred_user_id: string;
  amount: number;
  currency: string;
  level: number;
  rate: number;
  base_amount: number;
  status: "PENDING" | "CREDITED" | "REVERSED";
  qualifying_event: string;
  source_transaction_id: string | null;
  wallet_transaction_id: string | null;
  created_at: string;
  credited_at: string | null;
};

export type AppNotification = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  message: string;
  severity: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  link: string | null;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

export type FraudEvent = {
  id: string;
  user_id: string;
  event_type: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  score: number;
  details: Record<string, unknown>;
  status: "OPEN" | "REVIEWING" | "CLEARED" | "CONFIRMED";
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
};

export type AuditLog = {
  id: string;
  admin_id: string | null;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  ip_hash: string | null;
  user_agent: string | null;
  created_at: string;
};

export type Currency = {
  code: string;
  name: string;
  symbol: string;
  minor_unit: number;
  min_deposit: number;
  min_withdrawal: number;
  max_withdrawal: number;
  /** Flat fee charged only when `withdrawal_fee_percent` is 0. */
  withdrawal_fee: number;
  /** Percentage of the request charged as a fee. Takes precedence when above 0. */
  withdrawal_fee_percent: number;
  enabled: boolean;
};

/* -------------------------------------------------------------------------- */
/* Support                                                                    */
/* -------------------------------------------------------------------------- */

export type SupportTicketStatus = "OPEN" | "IN_REVIEW" | "RESOLVED" | "CLOSED";

export type SupportTicketCategory =
  | "GENERAL"
  | "PAYMENT"
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "ACCOUNT"
  | "REWARDS"
  | "REFERRALS"
  | "OTHER";

export type SupportTicket = {
  id: string;
  user_id: string;
  reference: string;
  category: SupportTicketCategory;
  subject: string;
  status: SupportTicketStatus;
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  related_reference: string | null;
  assigned_admin_id: string | null;
  last_activity_at: string;
  resolved_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SupportMessage = {
  id: string;
  ticket_id: string;
  author_id: string | null;
  author_role: "USER" | "ADMIN" | "SYSTEM";
  body: string;
  created_at: string;
};

/* -------------------------------------------------------------------------- */
/* Presentation labels                                                        */
/* -------------------------------------------------------------------------- */

export const SUPPORT_STATUS_LABELS: Record<SupportTicketStatus, string> = {
  OPEN: "Received",
  IN_REVIEW: "Being looked at",
  RESOLVED: "Answered",
  CLOSED: "Closed",
};

export const SUPPORT_CATEGORY_LABELS: Record<SupportTicketCategory, string> = {
  GENERAL: "Something else",
  PAYMENT: "A payment problem",
  DEPOSIT: "A deposit that did not arrive",
  WITHDRAWAL: "A withdrawal that is taking long",
  ACCOUNT: "I cannot get into my account",
  REWARDS: "A reward I did not receive",
  REFERRALS: "A referral question",
  OTHER: "Other",
};

export function supportStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return SUPPORT_STATUS_LABELS[status as SupportTicketStatus] ?? statusLabel(status);
}

export function supportCategoryLabel(category: string | null | undefined): string {
  if (!category) return "—";
  return SUPPORT_CATEGORY_LABELS[category as SupportTicketCategory] ?? statusLabel(category);
}

export const AD_STATUS_LABELS: Record<AdvertisementStatus, string> = {
  DRAFT: "Not published",
  ACTIVE: "Showing",
  PAUSED: "Paused",
  ARCHIVED: "Removed",
};

/*
  What the advert is about, in the advertiser's language rather than the
  database's. These are the words on the filter chips, so they are written the
  way someone browsing would say them.
*/
export const AD_CATEGORY_LABELS: Record<AdvertisementCategory, string> = {
  COMPANY_REGISTRATION: "Company registration",
  DEPOSITS: "Deposits",
  WITHDRAWALS: "Withdrawals",
  PAYMENTS: "Payments",
  OTHER: "Other",
};

export function adStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return AD_STATUS_LABELS[status as AdvertisementStatus] ?? statusLabel(status);
}

export function adCategoryLabel(category: string | null | undefined): string {
  if (!category) return "Other";
  return AD_CATEGORY_LABELS[category as AdvertisementCategory] ?? "Other";
}

/**
 * "Showing" and "Hidden" rather than ACTIVE/HIDDEN.
 *
 * An operator is deciding whether a picture is on the site, not setting a state
 * machine, and the two words they see here are the words the landing page
 * behaviour follows.
 */
export const COMPANY_IMAGE_STATUS_LABELS: Record<CompanyImageStatus, string> = {
  ACTIVE: "Showing",
  HIDDEN: "Hidden",
};

export function companyImageStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return COMPANY_IMAGE_STATUS_LABELS[status as CompanyImageStatus] ?? statusLabel(status);
}

export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  DEPOSIT: "Deposit",
  VIDEO_REWARD: "Video reward",
  TASK_REWARD: "Task reward",
  REFERRAL_REWARD: "Referral reward",
  WITHDRAWAL_HOLD: "Withdrawal hold",
  WITHDRAWAL: "Withdrawal",
  WITHDRAWAL_FEE: "Withdrawal fee",
  WITHDRAWAL_RELEASE: "Withdrawal released",
  REFUND: "Refund",
  REVERSAL: "Reversal",
  ADMIN_ADJUSTMENT: "Admin adjustment",
  PACKAGE_PURCHASE: "Package purchase",
};

export const STATUS_LABELS: Record<string, string> = {
  // Written for the person waiting, not for the database.
  //
  // `PENDING_ADMIN_APPROVAL` is the internal name and it leaked into the UI: a
  // first-time user read "Pending admin approval" and had to work out what an
  // "admin approval" was. Nobody outside the team should ever see a raw status,
  // so the wording here is what the user would say themselves.
  //
  // The map stays shared with the admin screens deliberately: these phrases are
  // still precise enough for staff ("Request declined" and "Payment couldn't be
  // completed" are different states and remain different), and two label sets
  // would drift apart until one of them was wrong.
  PENDING: "Pending",
  PENDING_ADMIN_APPROVAL: "Waiting for review",
  PROCESSING: "Payment being processed",
  APPROVED: "Approved — payment not sent yet",
  COMPLETED: "Completed",
  REJECTED: "Request declined",
  FAILED: "Payment couldn't be completed",
  CANCELLED: "Cancelled",
  REVERSED: "Reversed",
  REWARDED: "Rewarded",
  WATCHING: "Watching",
  STARTED: "Started",
  EXPIRED: "Expired",
  SUSPENDED: "Suspended",
  DRAFT: "Draft",
  ACTIVE: "Active",
  PAUSED: "Paused",
  QUALIFIED: "Qualified",
  CREDITED: "Credited",
  OPEN: "Open",
  REVIEWING: "Reviewing",
  CLEARED: "Cleared",
  CONFIRMED: "Confirmed",
  NOT_STARTED: "Not started",
  VERIFIED: "Verified",
  REQUIRES_REVIEW: "Requires review",
  NORMAL: "Normal",
  REVIEW: "Review",
  RESTRICTED: "Restricted",
  CLOSED: "Closed",
  IN_REVIEW: "Being looked at",
  RESOLVED: "Answered",
};

export function statusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ").toLowerCase();
}

/** Statuses that mean "this money is finished moving". */
export const TERMINAL_STATUSES: readonly string[] = [
  "COMPLETED",
  "FAILED",
  "REJECTED",
  "CANCELLED",
  "REVERSED",
];

/* Redeem codes — admin-generated monetary codes */
export type RedeemCodeStatus = "ACTIVE" | "EXPIRED" | "DISABLED";

export type RedeemCode = {
  id: string;
  code: string;
  amount: number;
  currency: string;
  max_redemptions: number;
  redemptions_used: number;
  expires_at: string | null;
  created_by: string | null;
  status: RedeemCodeStatus;
  created_at: string;
};

/* WhatsApp groups */
export type WhatsAppGroup = {
  id: string;
  name: string;
  invite_link: string;
  sort_order: number;
  user_start: number;
  user_end: number;
  is_active: boolean;
  created_at: string;
};

export type WhatsAppGroupAssignment = {
  id: string;
  name: string;
  invite_link: string;
  user_range: string;
};
