/**
 * Help content.
 *
 * Kept in one place so the support page and its search cannot drift apart. The
 * wording answers the question a user actually has, and it never promises an
 * outcome the platform cannot guarantee — no "instant withdrawals", no
 * "guaranteed earnings".
 */

export type HelpTopic = { question: string; answer: string; keywords: string[] };
export type HelpGroup = { group: string; topics: HelpTopic[] };

export const HELP_GROUPS: HelpGroup[] = [
  {
    group: "Getting started",
    topics: [
      {
        question: "How does TaskCash Pro work?",
        answer:
          "You complete eligible activities — mostly sponsored videos and approved tasks — and a reward is credited to your wallet. Every credit is recorded permanently, so your history always adds up to your balance. Nothing is earned just by signing up.",
        keywords: ["how", "works", "start", "begin", "tasks", "videos"],
      },
      {
        question: "What do I need to do first?",
        answer:
          "Add your mobile money number to your profile and confirm your email address. Your wallet and referral code are created automatically when you register. Once that is done, open Watch & Earn to see what is available.",
        keywords: ["profile", "phone", "verify", "email", "first", "setup"],
      },
      {
        question: "Why is my balance KES 0.00?",
        answer:
          "Every account starts at zero. That is the correct starting balance, not an error. Complete one eligible activity and your first reward will appear in your wallet and on your dashboard.",
        keywords: ["zero", "0.00", "empty", "balance", "nothing"],
      },
    ],
  },
  {
    group: "Earning and rewards",
    topics: [
      {
        question: "How are rewards calculated?",
        answer:
          "Each campaign has its own reward per completed activity, required watch time, and a budget. Your reward is calculated on our servers from the campaign configuration — never from anything your device sends — and is credited only after the watch is verified.",
        keywords: ["reward", "calculate", "how much", "amount", "campaign"],
      },
      {
        question: "Why did a video not pay out?",
        answer:
          "Usually one of four things: the required watch time was not met, you reached your daily limit for that video, the campaign's reward budget is exhausted, or the campaign was paused or ended. The exact reason is shown when the session finishes.",
        keywords: ["video", "no reward", "not paid", "failed", "watch"],
      },
      {
        question: "Is there a daily limit?",
        answer:
          "Campaigns can set a daily limit per account, and the platform can cap rewarded sessions per day. When you reach a limit, the app tells you plainly rather than silently refusing.",
        keywords: ["daily", "limit", "cap", "maximum"],
      },
      {
        question: "Can I earn a fixed amount every day?",
        answer:
          "No, and we will not promise one. Rewards depend on which campaigns are running, what they pay, and how much of their budget remains. Any figure that sounds guaranteed should be treated with suspicion.",
        keywords: ["guaranteed", "fixed", "daily income", "promise", "return"],
      },
    ],
  },
  {
    group: "Deposits and payments",
    topics: [
      {
        question: "I paid but my deposit has not arrived.",
        answer:
          "A deposit stays pending until the payment provider confirms it to us — we never credit a wallet because a screen said 'success'. If you completed a payment, wait for the confirmation, then check Wallet → Transaction history. If it is still missing after that, report it below with the reference from your history.",
        keywords: ["deposit", "payment", "not arrived", "missing", "pending", "paid"],
      },
      {
        question: "How do I add money to my wallet?",
        answer:
          "Open Deposit, enter the amount and your mobile money number, and confirm. You will receive a payment request on your phone. Your wallet is credited only once the provider confirms the payment.",
        keywords: ["deposit", "add money", "top up", "fund"],
      },
    ],
  },
  {
    group: "Withdrawals",
    topics: [
      {
        question: "How do I withdraw?",
        answer:
          "Open Withdraw, enter an amount and the mobile money number to be paid, and confirm. The amount moves from your available balance to locked, and a request is created for our team to review.",
        keywords: ["withdraw", "cash out", "payout", "request"],
      },
      {
        question: "Why is my withdrawal still pending?",
        answer:
          "Every withdrawal is checked by a person before any money is sent. That review is deliberate — it is how duplicate requests, compromised accounts and fraudulent payouts are caught. You will get a notification the moment the status changes.",
        keywords: ["pending", "waiting", "review", "slow", "why", "stuck"],
      },
      {
        question: "What happens if my withdrawal is declined?",
        answer:
          "The held amount returns to your available balance automatically and a 'withdrawal released' entry appears in your history. You are told why the request was declined.",
        keywords: ["declined", "rejected", "refused", "returned", "release"],
      },
      {
        question: "Why can't I withdraw yet?",
        answer:
          "The common reasons are: your available balance is below the minimum, you already have a withdrawal in review, you have reached your rolling 24-hour limit, your account is too new, or verification is required. The withdraw screen states which one applies to you.",
        keywords: ["cannot withdraw", "blocked", "minimum", "limit", "eligibility"],
      },
    ],
  },
  {
    group: "Referrals",
    topics: [
      {
        question: "How do referrals work?",
        answer:
          "Every account has a unique code and link. You may earn a commission when someone you invited completes the qualifying activity the platform has configured — not simply for opening the link. The referral dashboard shows your link and what each invited friend has done.",
        keywords: ["referral", "invite", "commission", "link", "code", "friends"],
      },
      {
        question: "Why have I not earned a referral reward?",
        answer:
          "A referral only pays once your invited friend completes the qualifying activity. Until then the referral shows as pending. Self-referrals and duplicate or circular referrals are rejected.",
        keywords: ["referral", "no reward", "pending", "not paid"],
      },
    ],
  },
  {
    group: "Account and security",
    topics: [
      {
        question: "How do I confirm my email address?",
        answer:
          "We send a confirmation link when you register. If it did not arrive, open the verify email page and request a new one — check your spam folder too. You must confirm your email before you can earn or withdraw.",
        keywords: ["email", "verify", "confirm", "verification", "link"],
      },
      {
        question: "I cannot sign in.",
        answer:
          "Use Forgot password on the sign-in page to set a new one. If the app says your email is not confirmed, request a new confirmation link. If neither helps, report it below and include the email address on the account.",
        keywords: ["login", "sign in", "password", "cannot", "locked out"],
      },
      {
        question: "Is my money safe?",
        answer:
          "Balances are held in an internal ledger where every movement is recorded permanently and financial changes can only be made by our servers — never by your browser. Withdrawals are reviewed by a person before payment, and sensitive operations are logged.",
        keywords: ["safe", "security", "secure", "ledger", "trust"],
      },
    ],
  },
];

/** Flattened list used by the search box. */
export const ALL_HELP_TOPICS: (HelpTopic & { group: string })[] = HELP_GROUPS.flatMap((group) =>
  group.topics.map((topic) => ({ ...topic, group: group.group })),
);
