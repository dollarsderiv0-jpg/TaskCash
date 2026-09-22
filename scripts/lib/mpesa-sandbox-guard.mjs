/**
 * Refuse to point production at a sandbox.
 *
 * The application already refuses to *call* Safaricom's sandbox host from a
 * production build (`resolveBaseUrl()` in `src/lib/payments/mpesa/config.ts`),
 * which protects the runtime. Nothing protected the *deployment*: a local
 * environment configured for the sandbox and a production environment sync sit
 * one command apart, and the sync is a routine, unremarkable thing to run.
 *
 * Two rules, in order of severity:
 *
 *   1. Credentials are pushed only from an environment that POSITIVELY declares
 *      `MPESA_ENV=production`. An absent `MPESA_ENV` is not a declaration of
 *      production — `mpesaEnvironment()` in src/lib/env.ts resolves anything
 *      that is not exactly "production" to sandbox — so silence is treated as
 *      the sandbox case, which is what it is at runtime. This rule runs before
 *      the evidence check on purpose: gating it on positive sandbox evidence
 *      would let through precisely the tree most likely to hold sandbox keys,
 *      one whose .env.local never had the line. It is refused even when the
 *      sandbox sync is otherwise explicitly allowed. Today
 *      `vercel-env-sync.mjs` does not push M-Pesa credentials at all — the rule
 *      exists so that stays true if the list is ever widened.
 *   2. A production sync from a sandbox-configured tree is refused, because the
 *      operator's local environment is a test environment and the sync writes
 *      production M-Pesa settings. `--allow-sandbox-mpesa-credentials`
 *      acknowledges it for the cases where that is genuinely intended.
 *
 * Only variable NAMES and hosts are ever reported. This module is pure — it
 * takes an env Map and returns a decision — so the rule can be tested directly
 * instead of by running the sync and hoping.
 */

/** Credentials whose value is app-specific, and therefore sandbox-or-live. */
export const MPESA_CREDENTIAL_VARS = [
  "MPESA_CONSUMER_KEY",
  "MPESA_CONSUMER_SECRET",
  "MPESA_PASSKEY",
  "MPESA_CALLBACK_SECRET",
  "MPESA_B2C_SECURITY_CREDENTIAL",
];

const SANDBOX_HOST = "sandbox.safaricom.co.ke";

/**
 * Non-secret evidence that this environment is aimed at the sandbox.
 *
 * Returns descriptors, never values — a variable name and, for the host, the
 * fact that it names Safaricom's sandbox rather than the URL itself.
 */
export function sandboxMpesaEvidence(env) {
  const evidence = [];

  if ((env.get("MPESA_ENV") ?? "").trim().toLowerCase() === "sandbox") {
    evidence.push("MPESA_ENV=sandbox");
  }

  const base = (env.get("MPESA_BASE_URL") ?? "").trim().replace(/\/+$/, "");
  if (base && base.endsWith(SANDBOX_HOST)) {
    evidence.push("MPESA_BASE_URL=<sandbox host>");
  }

  return evidence;
}

/**
 * Decide whether a sync may proceed.
 *
 * @param {object} input
 * @param {Map<string,string>} input.env            parsed .env.local
 * @param {string} input.target                     production | preview | development
 * @param {boolean} input.allowSandbox              --allow-sandbox-mpesa-credentials
 * @param {string[]} input.plannedNames             names the sync intends to push
 */
export function mpesaSyncRefusal({ env, target, allowSandbox = false, plannedNames = [] }) {
  const evidence = sandboxMpesaEvidence(env);

  const declaredEnv = (env.get("MPESA_ENV") ?? "").trim().toLowerCase();
  const claimsProduction = declaredEnv === "production";

  const planned = new Set(plannedNames);
  const credentialsWithheld = MPESA_CREDENTIAL_VARS.filter(
    (name) => env.get(name)?.trim() && planned.has(name),
  );

  /*
    Rule 1, deliberately FIRST — before the evidence gate. Positive sandbox
    evidence is only produced by an explicit `MPESA_ENV=sandbox` or a sandbox
    `MPESA_BASE_URL`, so a tree with neither would sail past a rule placed after
    it. That tree is the dangerous one: `MPESA_ENV` unset resolves to the sandbox
    host at runtime, so its credentials are sandbox credentials by default while
    nothing in the environment says so. Requiring a positive claim of production
    is what makes this fail-closed; inferring production from silence is what
    made it fail open.
  */
  if (credentialsWithheld.length > 0 && !claimsProduction) {
    return {
      blocked: true,
      evidence: evidence.length > 0 ? evidence : [`MPESA_ENV is ${declaredEnv || "unset"}`],
      credentialsWithheld,
      reason:
        `The sync would push ${credentialsWithheld.join(", ")}, but this environment does not declare ` +
        `MPESA_ENV=production (it is ${declaredEnv || "unset"}). An unset MPESA_ENV resolves to Safaricom's ` +
        "sandbox at runtime, so a credential held here cannot be assumed to be a live one — and sandbox " +
        "credentials must never reach a deployed environment, because they authenticate against a test app " +
        "and would replace working production credentials with unusable ones. Set MPESA_ENV=production if " +
        "these are live credentials, or clear them from .env.local first.",
    };
  }

  if (evidence.length === 0) {
    return { blocked: false, reason: null, evidence, credentialsWithheld: [] };
  }

  if (target === "production" && !allowSandbox) {
    return {
      blocked: true,
      evidence,
      credentialsWithheld: [],
      reason:
        `This environment is configured for Safaricom's sandbox (${evidence.join(", ")}), so a production sync ` +
        "would write it out as the live M-Pesa environment. That is refused on purpose: point your local " +
        "environment at production first (or run the sandbox test in a tree that is not the one you deploy " +
        "from). Pass --allow-sandbox-mpesa-credentials only if you intended exactly this.",
    };
  }

  return { blocked: false, reason: null, evidence, credentialsWithheld: [] };
}
