/**
 * Legal documents.
 *
 * These are working drafts written to describe how the platform actually
 * operates. They deliberately contain NO invented registration numbers,
 * licences, certifications or regulatory approvals — the business owner must
 * supply those in the platform settings, and they are rendered from there.
 *
 * Have a qualified lawyer review these before launch.
 */

export type LegalSection = {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
};

export type LegalDocument = {
  slug: string;
  title: string;
  summary: string;
  updated: string;
  sections: LegalSection[];
};

export const LEGAL_DOCUMENTS: Record<string, LegalDocument> = {
  terms: {
    slug: "terms",
    title: "Terms of Service",
    summary:
      "The agreement between you and the operator of TaskCash Pro covering your account, eligible activities, rewards and withdrawals.",
    updated: "Pending legal review",
    sections: [
      {
        heading: "1. Who we are",
        paragraphs: [
          "TaskCash Pro is a rewards and engagement platform. The identity of the legal entity operating this platform, together with its registration details and business address, is published in the site footer and on the contact page once supplied by the operator.",
          "TaskCash Pro is not a bank, a licensed payment service provider, an investment manager, a securities platform or a financial institution. We do not hold your money as a deposit-taking institution.",
        ],
      },
      {
        heading: "2. Your account",
        paragraphs: [
          "You must provide accurate registration information and keep your credentials secure. One person may not operate multiple accounts to obtain additional rewards or referral commissions. We may place accounts under review if we detect duplicate, shared or automated use.",
        ],
        bullets: [
          "You are responsible for activity performed through your account.",
          "You must be legally able to enter into this agreement in your jurisdiction.",
          "We may suspend an account that breaches these terms, after review.",
        ],
      },
      {
        heading: "3. Eligible activities and rewards",
        paragraphs: [
          "Rewards are earned by completing eligible activities under the rules of a specific campaign at the time you complete it. Reward amounts, required watch durations, daily limits, cooldowns and campaign budgets are set by administrators and shown in the app.",
          "We do not promise any particular level of earnings, any daily or monthly income, or any return on a deposit. Campaigns are limited by budget and may end or pause at any time.",
        ],
      },
      {
        heading: "4. Deposits",
        paragraphs: [
          "Where a platform plan requires a deposit, the deposit is a payment for access to platform services. It is not an investment, a loan, a deposit for safekeeping, or a product that pays interest or profit.",
          "Deposits are credited to your wallet only after our payment partner independently confirms the transaction.",
        ],
      },
      {
        heading: "5. Withdrawals",
        paragraphs: [
          "Withdrawal requests are reviewed by our administration team before payment is sent. When you submit a request, the requested amount is moved from your available balance to your locked balance while it is under review.",
          "If a request is rejected or the payout fails, the held funds are returned to your available balance. Withdrawals are subject to minimum and maximum amounts, daily limits prevailing in your currency, account status and any verification requirements.",
        ],
      },
      {
        heading: "6. Prohibited conduct",
        bullets: [
          "Automating activity, simulating watch time, or tampering with session timing.",
          "Creating multiple accounts, or accounts to farm referral commissions.",
          "Manipulating balances, transaction statuses or reward amounts through any means.",
          "Using the platform for money laundering, fraud or any unlawful purpose.",
        ],
      },
      {
        heading: "7. Changes and termination",
        paragraphs: [
          "We may update these terms. Material changes will be reflected by the effective date on this page. You may close your account at any time, subject to any settled or in-flight transactions.",
        ],
      },
      {
        heading: "8. Contact",
        paragraphs: [
          "Questions about these terms should be sent to the support contact published on our contact page.",
        ],
      },
    ],
  },

  privacy: {
    slug: "privacy",
    title: "Privacy Policy",
    summary: "What personal information we collect, why we collect it, and the choices you have.",
    updated: "Pending legal review",
    sections: [
      {
        heading: "1. Information we collect",
        bullets: [
          "Account details: your full name, email address, mobile money number, country and selected currency.",
          "Transaction records: deposits, rewards, referral commissions, withdrawal requests and the ledger entries they produce.",
          "Technical and security signals: a keyed hash of your IP address, a keyed hash of your device identifier, and your browser user agent.",
          "Activity records: which campaign sessions you started, how long the server observed them, and whether a reward was issued.",
        ],
      },
      {
        heading: "2. What we do not store",
        paragraphs: [
          "We do not store your raw IP address or raw device identifier in our application records — they are stored as keyed hashes that cannot be reversed without our server secret. We never store your payment provider credentials, and card or bank details are never entered into this application.",
        ],
      },
      {
        heading: "3. Why we use it",
        bullets: [
          "To operate your account and maintain the wallet ledger.",
          "To verify activities and calculate rewards.",
          "To process deposits and pay approved withdrawals through our payment partner.",
          "To detect and review abuse, fraud and duplicate accounts.",
          "To meet our legal and record-keeping obligations.",
        ],
      },
      {
        heading: "4. Sharing",
        paragraphs: [
          "We share the minimum necessary information with our payment partner to collect deposits and pay approved withdrawals — typically your mobile money number, the amount and a unique transaction reference. We use infrastructure providers for hosting, database and authentication services.",
        ],
      },
      {
        heading: "5. Retention",
        paragraphs: [
          "Financial records are retained for as long as required for accounting, tax and dispute-resolution purposes. Security hashes are retained while they remain relevant to fraud prevention.",
        ],
      },
      {
        heading: "6. Your choices",
        paragraphs: [
          "You can request access to, correction of, or deletion of your personal information, subject to records we are required to keep. The contact for privacy and data protection requests is published on our contact page.",
        ],
      },
    ],
  },

  cookies: {
    slug: "cookies",
    title: "Cookie Policy",
    summary: "How TaskCash Pro uses cookies and local storage.",
    updated: "Pending legal review",
    sections: [
      {
        heading: "1. Essential cookies",
        paragraphs: [
          "We use strictly necessary cookies to keep you signed in and to protect your session. These cannot be switched off, because without them the service cannot function securely.",
        ],
      },
      {
        heading: "2. Local storage",
        paragraphs: [
          "We may store a randomly generated device identifier in your browser's local storage. It is used only as an anti-fraud signal and it is stored on our servers as a keyed hash, not in a readable form.",
        ],
      },
      {
        heading: "3. What we do not use",
        paragraphs: [
          "We do not use advertising cookies, third-party tracking pixels or cross-site behavioural profiling on the authenticated application.",
        ],
      },
      {
        heading: "4. Managing cookies",
        paragraphs: [
          "You can clear or block cookies in your browser settings. Blocking essential cookies will prevent you from signing in.",
        ],
      },
    ],
  },

  "rewards-policy": {
    slug: "rewards-policy",
    title: "Rewards Policy",
    summary: "Exactly how rewards are calculated, capped and paid — and what is not promised.",
    updated: "Pending legal review",
    sections: [
      {
        heading: "1. Rewards are activity-based",
        paragraphs: [
          "Every reward is earned by completing an eligible activity under the rules of a specific campaign. The reward value is defined on the campaign record by an administrator and is read by our servers when the activity is verified.",
        ],
      },
      {
        heading: "2. We never guarantee an amount",
        paragraphs: [
          "We do not offer guaranteed daily, weekly or monthly earnings. We do not offer interest, profit share or a fixed return on a deposit. Any figure you see in the app relates to a specific campaign and its remaining budget.",
        ],
      },
      {
        heading: "3. How a video reward is verified",
        bullets: [
          "The server records the moment the watch session started.",
          "Progress is clamped to the wall-clock time that has actually elapsed — you cannot claim to have watched more time than has passed.",
          "The required watch duration defined on the campaign must be met.",
          "Campaign status, campaign budget, view limits, daily limits, cooldowns and account eligibility are all re-checked at the moment of payout.",
          "The reward is then written to your wallet ledger with a unique reference.",
        ],
      },
      {
        heading: "4. Campaign budgets are a hard ceiling",
        paragraphs: [
          "Each campaign has a budget. Once the budget is exhausted, rewards for that campaign stop automatically, even if the campaign is still listed. This is enforced in the database, not in the interface.",
        ],
      },
      {
        heading: "5. Limits and review",
        paragraphs: [
          "Daily activity limits, cooldown periods and velocity checks apply. A session that fails verification is not rewarded, and unusual patterns are sent to our review queue rather than being acted on automatically.",
        ],
      },
      {
        heading: "6. Referral commissions",
        paragraphs: [
          "Referral commissions are paid on eligible activity from a referral that has completed the configured qualifying event, at the rate published in the referral program at that time. Self-referrals, duplicate referrals and circular referral structures are blocked.",
        ],
      },
    ],
  },

  "withdrawal-policy": {
    slug: "withdrawal-policy",
    title: "Withdrawal Policy",
    summary: "How withdrawal requests are reserved, reviewed, paid, or returned to you.",
    updated: "Pending legal review",
    sections: [
      {
        heading: "1. Every withdrawal is reviewed",
        paragraphs: [
          "There is no automatic payout. When you submit a withdrawal request it enters a review queue and is examined by our administration team before any payment is initiated.",
        ],
      },
      {
        heading: "2. What happens when you submit a request",
        bullets: [
          "Your available balance must cover the request.",
          "Eligibility rules are checked: minimum and maximum amounts, rolling 24-hour limit, account status, verification requirements and any existing pending request.",
          "The requested amount moves from your available balance to your locked balance.",
          "A hold entry is written to your wallet ledger with a unique reference.",
        ],
      },
      {
        heading: "3. Outcomes",
        bullets: [
          "Approved: payment is initiated to your mobile money number through our payment partner. The withdrawal is only marked completed once the provider confirms it.",
          "Rejected: the held funds are returned to your available balance and the reason is recorded.",
          "Provider failure: the held funds are returned to your available balance and you are notified.",
        ],
      },
      {
        heading: "4. Verification and limits",
        paragraphs: [
          "Withdrawals may require a verified account depending on the rules in force, and are subject to the minimum, maximum and daily limits shown on the withdrawal screen for your currency. Fees, where applicable, are shown before you confirm.",
        ],
      },
      {
        heading: "5. Destination",
        paragraphs: [
          "Payouts are sent to the mobile money number you provide. Make sure it is correct and registered in your own name: funds sent to a wrong or third-party number may not be recoverable.",
        ],
      },
    ],
  },

  "refund-policy": {
    slug: "refund-policy",
    title: "Refund Policy",
    summary: "When a deposit can be refunded, and how incorrectly processed amounts are handled.",
    updated: "Pending legal review",
    sections: [
      {
        heading: "1. Deposits that were never confirmed",
        paragraphs: [
          "A deposit is only credited to your wallet after our payment partner confirms it. If a payment is confirmed by the provider but cannot be credited, we will investigate and either credit it or return the amount.",
        ],
      },
      {
        heading: "2. Erroneous or duplicate charges",
        paragraphs: [
          "If you believe you were charged incorrectly — for example a duplicate collection for the same reference — contact support with the payment reference shown in your deposit history. Confirmed erroneous amounts are returned to your wallet or refunded to the originating number.",
        ],
      },
      {
        heading: "3. Unused platform access",
        paragraphs: [
          "Where a deposit purchased access to a platform plan and that access has not been used, you may request a refund within 14 days. Amounts already applied to consumed services, or already withdrawn, are not refundable.",
        ],
      },
      {
        heading: "4. Rewards are not refundable",
        paragraphs: [
          "Rewards credited for completed activities are earned value; they are not refundable payments. Reversed or invalid rewards are handled through the ledger as a reversal or an adjustment, always with an auditable reason.",
        ],
      },
      {
        heading: "5. How to request",
        paragraphs: [
          "Send your request to the support contact on our contact page, quoting the reference of the transaction. Include the amount and date so we can reconcile it against provider records.",
        ],
      },
    ],
  },

  "responsible-use": {
    slug: "responsible-use",
    title: "Responsible Use & Financial Notice",
    summary:
      "What TaskCash Pro is and is not, and how to use it without treating it as an income guarantee.",
    updated: "Pending legal review",
    sections: [
      {
        heading: "1. This is a rewards platform, not an investment",
        paragraphs: [
          "TaskCash Pro rewards you for completing eligible sponsored activities. It is not an investment scheme, a savings product, a trading platform or a deposit-taking business. We do not offer guaranteed returns of any kind.",
        ],
      },
      {
        heading: "2. Rewards depend on campaigns",
        paragraphs: [
          "Campaign availability changes. Advertisers fund campaigns with limited budgets and defined end dates. When a budget is exhausted or a campaign ends, rewards for it stop. Nobody should treat platform rewards as a replacement for employment income.",
        ],
      },
      {
        heading: "3. Do not deposit money you need",
        paragraphs: [
          "Only deposit money you can comfortably leave in the platform if a campaign you intended to complete becomes unavailable. Never borrow money to deposit. Never deposit on the expectation of a fixed daily return — no such return exists here.",
        ],
      },
      {
        heading: "4. Protect yourself",
        bullets: [
          "Nobody from TaskCash Pro will ever ask for your password or a one-time code to release a withdrawal.",
          "We never ask you to pay a fee to release earnings. Approval is a review step, not a fee.",
          "If someone promises you guaranteed earnings 'through TaskCash Pro', that person does not represent us.",
        ],
      },
      {
        heading: "5. If something goes wrong",
        paragraphs: [
          "Contact support through the details on our contact page. Every transaction has a reference you can quote, and every ledger entry is auditable by our team.",
        ],
      },
    ],
  },
};

export function getLegalDocument(slug: string): LegalDocument | null {
  return LEGAL_DOCUMENTS[slug] ?? null;
}
