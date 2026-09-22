import { z } from "zod";

/**
 * Environment access.
 *
 * Two hard rules are enforced here:
 *  1. Secrets are read lazily, at request time, never at module scope — so a
 *     build never needs production credentials and never inlines them.
 *  2. If SasaPay credentials are missing in production, payment functions
 *     throw. They never fall back to a simulated success.
 */

export class EnvError extends Error {
  constructor(message: string, public readonly missing: string[] = []) {
    super(message);
    this.name = "EnvError";
  }
}

/* -------------------------------------------------------------------------- */
/* Public (browser-safe) configuration                                        */
/* -------------------------------------------------------------------------- */

export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabasePublishableKey:
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    "",
  appUrl:
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "",
} as const;

export function getPublicSupabaseConfig(): { url: string; key: string } {
  if (!publicEnv.supabaseUrl || !publicEnv.supabasePublishableKey) {
    throw new EnvError(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.",
      ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"],
    );
  }
  return { url: publicEnv.supabaseUrl, key: publicEnv.supabasePublishableKey };
}

export function isSupabaseConfigured(): boolean {
  return Boolean(publicEnv.supabaseUrl && publicEnv.supabasePublishableKey);
}

/**
 * The JWKS document for this project, used to verify a Supabase-issued JWT
 * server-side, without a network round trip.
 *
 * Consumed by `@/lib/supabase/bearer` when a request presents
 * `Authorization: Bearer <access token>`. Optional: without it the auth service
 * does the verifying instead, so its absence is a slower path rather than a
 * broken one. Only a malformed value is a configuration fault.
 */
export function getSupabaseJwksUrl(): string | null {
  return process.env.SUPABASE_JWKS_URL ?? null;
}

/** True when the migration workflow has a database to talk to. */
export function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * The server-only Supabase secret key.
 *
 * `SUPABASE_SECRET_KEY` is the current name for this key. The legacy
 * `SUPABASE_SERVICE_ROLE_KEY` name is still accepted so existing deployments
 * keep working, but new configuration should use the new name.
 *
 * Read through `process.env` at call time — never at module scope — so a value
 * can never be inlined into a client bundle.
 */
/**
 * A publishable key has no server privileges. If one is placed in the secret
 * slot it is treated as *absent* rather than passed to the database, so the
 * deployment fails closed with a configuration error instead of issuing
 * queries that RLS silently reduces to nothing.
 */
function usableAdminKey(value: string | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("sb_publishable_")) return null;
  return value;
}

export function getSupabaseAdminKey(): string | null {
  return (
    usableAdminKey(process.env.SUPABASE_SECRET_KEY) ??
    usableAdminKey(process.env.SUPABASE_SERVICE_ROLE_KEY)
  );
}

/** True when a publishable key was put where the secret key belongs. */
export function hasMisplacedPublishableKey(): boolean {
  return (
    Boolean(process.env.SUPABASE_SECRET_KEY?.startsWith("sb_publishable_")) ||
    Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.startsWith("sb_publishable_"))
  );
}

/** True when the server has everything it needs to bypass RLS safely. */
export function hasSupabaseAdminCredentials(): boolean {
  return Boolean(publicEnv.supabaseUrl && getSupabaseAdminKey());
}

/**
 * Configuration is reported in three groups, because they fail differently and
 * are fixed in three different places:
 *
 *   public    — shipped to the browser; a missing one breaks rendering.
 *   server    — secrets and server-only values; a missing one means the
 *               deployment cannot serve money or auth at all.
 *   database  — needed by the migration/verification scripts. Deliberately NOT
 *               part of the runtime gate: a deployed app has no business
 *               holding a direct Postgres connection string.
 *
 * Names only, never values — variable names are not secrets, and without them
 * the "setup incomplete" state gives nobody anything to act on.
 */
export type ConfigCategory = "public" | "server" | "database";

export function missingConfigByCategory(): Record<ConfigCategory, string[]> {
  const publicMissing: string[] = [];
  if (!publicEnv.supabaseUrl) publicMissing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!publicEnv.supabasePublishableKey) {
    publicMissing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  }

  const serverMissing: string[] = [];
  if (!getSupabaseAdminKey()) serverMissing.push("SUPABASE_SECRET_KEY");
  // Same fault, different message: the variable IS set, to the wrong kind of key.
  if (hasMisplacedPublishableKey()) serverMissing.push("SUPABASE_SECRET_KEY(=publishable)");
  if (!(process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL)) serverMissing.push("APP_URL");
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret || authSecret.length < 32) serverMissing.push("AUTH_SECRET");

  const databaseMissing: string[] = [];
  if (!process.env.DATABASE_URL) databaseMissing.push("DATABASE_URL");

  return { public: publicMissing, server: serverMissing, database: databaseMissing };
}

/** Every variable that is missing, in no particular order. */
export function supabaseConfigMissing(): string[] {
  const byCategory = missingConfigByCategory();
  return [...byCategory.public, ...byCategory.server];
}

/** Every server-side requirement the application cannot start without. */
export function missingServerConfigKeys(): string[] {
  const byCategory = missingConfigByCategory();
  return [...byCategory.public, ...byCategory.server];
}

/**
 * Shown to users when the deployment has no database behind it yet.
 *
 * Written for a user, not an operator.
 *
 * These strings previously described the fault precisely — "its schema has not
 * been applied yet" — which is accurate, unhelpful, and alarming: it tells a
 * first-time visitor about our migrations. The precise cause is still recorded
 * under a distinct error CODE (PLATFORM_NOT_CONFIGURED / PLATFORM_NOT_MIGRATED)
 * and in the structured log, which is where an operator should look; the person
 * signing up just needs to know it is not their fault and whether to retry.
 *
 * Both map to the same sentence on purpose: from outside the team, "the
 * database has not been migrated" and "the keys are missing" are the same
 * event — TaskCash is not ready yet — and distinguishing them would leak
 * infrastructure detail for no benefit to the user.
 *
 * Safe to import from client components — it reads only browser-safe
 * configuration.
 */
export const PLATFORM_NOT_CONFIGURED_MESSAGE =
  "TaskCash is completing its setup. Please try again shortly.";

/**
 * Shown when the backend is configured but its schema is absent — the
 * migrations have never been applied. Retrying can never fix this, so it is
 * reported as a configuration fault rather than "please try again".
 */
export const PLATFORM_NOT_MIGRATED_MESSAGE =
  "TaskCash is completing its setup. Please try again shortly.";

/* -------------------------------------------------------------------------- */
/* Server-only configuration                                                  */
/* -------------------------------------------------------------------------- */

const serverEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  // One of these two must be present; resolved into `supabaseSecretKey` below.
  SUPABASE_SECRET_KEY: z.string().min(20).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  // Optional: only the (not yet built) JWT-verification path needs it.
  SUPABASE_JWKS_URL: z.string().url().optional(),
  APP_URL: z.string().url(),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  CRON_SECRET: z.string().min(16).optional(),
  ADMIN_EMAIL: z.string().email().optional(),
  SASAPAY_CLIENT_ID: z.string().min(1).optional(),
  SASAPAY_CLIENT_SECRET: z.string().min(1).optional(),
  SASAPAY_MERCHANT_CODE: z.string().min(1).optional(),
  SASAPAY_API_URL: z.string().url().optional(),
  SASAPAY_CALLBACK_URL: z.string().url().optional(),
  SASAPAY_ENV: z.enum(["sandbox", "production"]).optional(),
  SASAPAY_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  // PayHero. Credentials are an API username and password issued in the PayHero
  // dashboard and sent as HTTP Basic on every request — there is no OAuth token
  // endpoint, so there is nothing to refresh.
  PAYHERO_API_USERNAME: z.string().min(1).optional(),
  PAYHERO_API_PASSWORD: z.string().min(1).optional(),
  // The payment channel (till/paybill) registered in the PayHero dashboard.
  // Numeric, but declared as a string so a stray space in a dashboard copy/paste
  // is normalised rather than rejected.
  PAYHERO_CHANNEL_ID: z.string().min(1).optional(),
  // The PayHero ACCOUNT the channel belongs to. Not used to route anything — the
  // channel id does that. It exists so preflight can prove the configured
  // channel sits on the intended account, which is what catches the mistake of
  // configuring the account id as the channel id: both are numeric, they are
  // different numbers, and the wrong one authenticates perfectly and then
  // routes nothing.
  PAYHERO_ACCOUNT_ID: z.string().min(1).optional(),
  PAYHERO_API_URL: z.string().url().optional(),
  PAYHERO_CALLBACK_URL: z.string().url().optional(),
  PAYHERO_CALLBACK_SECRET: z.string().min(8).optional(),
  PAYHERO_CALLBACK_IPS: z.string().optional(),
  PAYHERO_DEFAULT_NETWORK_CODE: z.string().min(1).optional(),
  PAYHERO_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  // Which provider the application actually uses.
  //
  // An explicit value always wins. When it is unset, PayHero is chosen if its
  // credentials are present (so adding the API keys is all it takes to switch),
  // and otherwise M-Pesa — the historical default — is reported, which means a
  // completely unconfigured deployment says "M-Pesa is not configured" rather
  // than silently reaching for a provider nobody set up.
  //
  // SASAPAY is retained rather than deleted: its implementation is complete and
  // working, and removing it would also remove the local simulator.
  PAYMENTS_PROVIDER: z.enum(["mpesa", "sasapay", "payhero"]).optional(),
  MPESA_ENV: z.enum(["sandbox", "production"]).optional(),
  MPESA_CONSUMER_KEY: z.string().min(1).optional(),
  MPESA_CONSUMER_SECRET: z.string().min(1).optional(),
  MPESA_SHORTCODE: z.string().min(1).optional(),
  MPESA_PASSKEY: z.string().min(1).optional(),
  MPESA_CALLBACK_URL: z.string().url().optional(),
  MPESA_CALLBACK_SECRET: z.string().min(8).optional(),
  MPESA_CALLBACK_IPS: z.string().optional(),
  MPESA_B2C_INITIATOR_NAME: z.string().min(1).optional(),
  MPESA_B2C_SECURITY_CREDENTIAL: z.string().min(1).optional(),
  MPESA_B2C_SHORTCODE: z.string().min(1).optional(),
  MPESA_B2C_COMMAND_ID: z.enum(["BusinessPayment", "SalaryPayment", "PromotionPayment"]).optional(),
  MPESA_B2C_RESULT_URL: z.string().url().optional(),
  MPESA_B2C_QUEUE_TIMEOUT_URL: z.string().url().optional(),
  MPESA_TRANSACTION_TYPE: z.enum(["CustomerPayBillOnline", "CustomerBuyGoodsOnline"]).optional(),
  MPESA_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  // A sandbox-only deposit floor. See mpesaSandboxMinDeposit() — it is inert
  // unless the application is in development, pointed at Daraja's sandbox, and
  // actually collecting through M-Pesa.
  MPESA_SANDBOX_MIN_DEPOSIT: z.coerce.number().int().nonnegative().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema> & {
  /** Resolved secret key: SUPABASE_SECRET_KEY, falling back to the legacy name. */
  supabaseSecretKey: string;
  sasapayEnv: "sandbox" | "production";
  nodeEnv: "development" | "production" | "test";
};

let cachedEnv: ServerEnv | null = null;

function nodeEnv(): ServerEnv["nodeEnv"] {
  const raw = process.env.NODE_ENV;
  if (raw === "production" || raw === "test") return raw;
  return "development";
}

export function isProduction(): boolean {
  return nodeEnv() === "production";
}

export function getServerEnv(): ServerEnv {
  if (cachedEnv) return cachedEnv;

  const parsed = serverEnvSchema.safeParse({
    ...process.env,
    // APP_URL is required server-side; fall back to the public one so a
    // single-variable deployment still works.
    APP_URL: process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL,
  });

  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".") || "unknown");
    throw new EnvError(
      `Server environment is invalid or incomplete: ${missing.join(", ")}`,
      missing,
    );
  }

  const supabaseSecretKey = getSupabaseAdminKey();
  if (!supabaseSecretKey) {
    throw new EnvError(
      hasMisplacedPublishableKey()
        ? "Server environment is invalid: SUPABASE_SECRET_KEY holds a publishable key, which has no server privileges. Use the Supabase secret key (sb_secret_...)."
        : "Server environment is invalid or incomplete: SUPABASE_SECRET_KEY",
      ["SUPABASE_SECRET_KEY"],
    );
  }

  cachedEnv = {
    ...parsed.data,
    supabaseSecretKey,
    sasapayEnv: parsed.data.SASAPAY_ENV ?? (nodeEnv() === "production" ? "production" : "sandbox"),
    nodeEnv: nodeEnv(),
  };
  return cachedEnv;
}

/** True only when every credential SasaPay needs to be called is present. */
export function hasPaymentCredentials(): boolean {
  return Boolean(
    process.env.SASAPAY_CLIENT_ID &&
      process.env.SASAPAY_CLIENT_SECRET &&
      process.env.SASAPAY_MERCHANT_CODE &&
      process.env.SASAPAY_API_URL,
  );
}

/**
 * The payment simulator exists so local development does not require live
 * merchant credentials. It is opt-in, loudly logged, and structurally unable
 * to run in production.
 */
export function isPaymentSimulatorEnabled(): boolean {
  if (nodeEnv() === "production") return false;
  return process.env.SASAPAY_SIMULATOR === "1" || process.env.SASAPAY_SIMULATOR === "true";
}

export function missingPaymentEnv(): string[] {
  const keys = [
    "SASAPAY_CLIENT_ID",
    "SASAPAY_CLIENT_SECRET",
    "SASAPAY_MERCHANT_CODE",
    "SASAPAY_API_URL",
  ];
  return keys.filter((k) => !process.env[k]);
}

/* -------------------------------------------------------------------------- */
/* PayHero                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything a PayHero collection needs. Names only.
 *
 * `PAYHERO_CHANNEL_ID` is included because the STK push cannot be routed
 * without it — it names which till/paybill receives the money, and a request
 * without it is refused by PayHero rather than defaulted.
 */
export const PAYHERO_COLLECTION_KEYS = [
  "PAYHERO_API_USERNAME",
  "PAYHERO_API_PASSWORD",
  "PAYHERO_CHANNEL_ID",
] as const;

/**
 * Everything a PayHero payout needs.
 *
 * The same credential set as a collection: PayHero authenticates both
 * directions with the one API username/password, and a payout is routed by the
 * recipient's network code, which has a sensible default. Declared as its own
 * constant anyway so the two directions stay independently checkable — the
 * day PayHero issues a separate credential for payouts, only this list changes.
 */
export const PAYHERO_PAYOUT_KEYS = PAYHERO_COLLECTION_KEYS;

export function missingPayheroCollectionEnv(): string[] {
  return PAYHERO_COLLECTION_KEYS.filter((key) => !process.env[key]?.trim());
}

export function missingPayheroPayoutEnv(): string[] {
  return PAYHERO_PAYOUT_KEYS.filter((key) => !process.env[key]?.trim());
}

/** True when deposits can be collected through PayHero. */
export function hasPayheroCollectionCredentials(): boolean {
  return missingPayheroCollectionEnv().length === 0;
}

/** True when a payout can leave through PayHero. */
export function hasPayheroPayoutCredentials(): boolean {
  return missingPayheroPayoutEnv().length === 0;
}

/**
 * The registered payment channel id, or null when it is absent or not numeric.
 *
 * Returns null rather than throwing so the caller can report "not configured"
 * naming the offending variable, instead of a generic failure.
 */
export function payheroChannelId(): number | null {
  const raw = process.env.PAYHERO_CHANNEL_ID?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/* -------------------------------------------------------------------------- */
/* M-Pesa (Safaricom Daraja)                                                  */
/* -------------------------------------------------------------------------- */

/** Everything an STK Push needs. Names only. */
export const MPESA_COLLECTION_KEYS = [
  "MPESA_CONSUMER_KEY",
  "MPESA_CONSUMER_SECRET",
  "MPESA_SHORTCODE",
  "MPESA_PASSKEY",
  "MPESA_CALLBACK_URL",
] as const;

/** Everything a B2C payout needs, on top of the collection set. Names only. */
export const MPESA_PAYOUT_KEYS = [
  "MPESA_B2C_INITIATOR_NAME",
  "MPESA_B2C_SECURITY_CREDENTIAL",
  "MPESA_B2C_RESULT_URL",
  "MPESA_B2C_QUEUE_TIMEOUT_URL",
] as const;

export function missingMpesaCollectionEnv(): string[] {
  return MPESA_COLLECTION_KEYS.filter((key) => !process.env[key]?.trim());
}

export function missingMpesaPayoutEnv(): string[] {
  return MPESA_PAYOUT_KEYS.filter((key) => !process.env[key]?.trim());
}

/** True when deposits can be collected through M-Pesa. */
export function hasMpesaCollectionCredentials(): boolean {
  return missingMpesaCollectionEnv().length === 0;
}

/**
 * True when a payout can leave through M-Pesa. Deliberately stricter than the
 * collection check: taking money in and sending money out are configured by
 * different credential sets, and conflating them hides a missing B2C account
 * until an administrator approves a withdrawal.
 */
export function hasMpesaPayoutCredentials(): boolean {
  return hasMpesaCollectionCredentials() && missingMpesaPayoutEnv().length === 0;
}

export function mpesaEnvironment(): "sandbox" | "production" {
  return process.env.MPESA_ENV?.trim() === "production" ? "production" : "sandbox";
}

/**
 * A deposit floor that applies ONLY to a local test against Daraja's sandbox.
 *
 * Why this exists rather than a change to `currencies.min_deposit`: the live
 * floor is KES 800, sourced from the production database, and a sandbox run
 * needs to move a trivial amount. Lowering that row would mean editing live
 * payment configuration to run a test — and then remembering to put it back,
 * with the risk of leaving the live floor at KES 50. This is the same outcome
 * with nothing to undo: the sandbox floor lives in the local environment, so it
 * disappears when the variable does, and the production row is never touched.
 *
 * Three independent locks, all of which must hold:
 *
 *   1. `NODE_ENV` is not production. A production build can never see it — and
 *      this is checked here rather than relied upon from `resolveBaseUrl()`,
 *      which refuses sandbox hosts in production but says nothing about limits.
 *   2. `MPESA_ENV` is sandbox. Pointed at the live host, the real floor applies.
 *   3. The active provider is M-Pesa. PayHero and SasaPay deposits are unaffected.
 *
 * It can only ever LOWER a floor (`limits.ts` ignores it above the real
 * minimum), so a mistaken value cannot make an amount chargeable that would
 * otherwise be refused. Returns null when no override applies.
 */
export function mpesaSandboxMinDeposit(): number | null {
  const raw = process.env.MPESA_SANDBOX_MIN_DEPOSIT?.trim();
  if (!raw) return null;
  if (isProduction()) return null;
  if (mpesaEnvironment() !== "sandbox") return null;
  if (activePaymentProvider() !== "mpesa") return null;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * Which provider the money paths use.
 *
 * An explicit `PAYMENTS_PROVIDER` always wins. Otherwise M-Pesa is the default
 * (the platform decision), which also means an unconfigured deployment reports
 * "M-Pesa is not configured" rather than silently reaching for a provider that
 * was never set up.
 */
export function activePaymentProvider(): "mpesa" | "sasapay" | "payhero" {
  const explicit = process.env.PAYMENTS_PROVIDER?.trim().toLowerCase();
  if (explicit === "sasapay" || explicit === "payhero" || explicit === "mpesa") return explicit;

  // No explicit choice: prefer a provider that is actually configured, so
  // adding PayHero credentials activates it without a second edit. Health and
  // the admin screen both report which provider this resolved to.
  if (hasPayheroCollectionCredentials()) return "payhero";

  return "mpesa";
}

/**
 * Can the active provider execute the given direction?
 *
 * Collections and payouts are reported separately because they fail in
 * different places: a missing collection credential stops deposits, a missing
 * payout credential stops withdrawals, and an operator needs to know which.
 */
export function providerConfigured(direction: "COLLECT" | "PAYOUT"): boolean {
  const provider = activePaymentProvider();

  if (provider === "sasapay") {
    // SasaPay's four variables cover both directions, and it additionally has
    // an explicit local simulator.
    return hasPaymentCredentials() || isPaymentSimulatorEnabled();
  }

  if (provider === "payhero") {
    return direction === "PAYOUT"
      ? hasPayheroPayoutCredentials()
      : hasPayheroCollectionCredentials();
  }

  return direction === "PAYOUT" ? hasMpesaPayoutCredentials() : hasMpesaCollectionCredentials();
}

/** Variable NAMES the active provider is missing, for the given direction. */
export function missingProviderEnv(direction: "COLLECT" | "PAYOUT"): string[] {
  const provider = activePaymentProvider();

  if (provider === "sasapay") return missingPaymentEnv();

  if (provider === "payhero") {
    return direction === "PAYOUT" ? missingPayheroPayoutEnv() : missingPayheroCollectionEnv();
  }

  return direction === "PAYOUT"
    ? [...missingMpesaCollectionEnv(), ...missingMpesaPayoutEnv()]
    : missingMpesaCollectionEnv();
}
