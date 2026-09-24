import { quoteWithdrawal } from "./fees";
import type {
  DemoState,
  ID,
  Package,
  Referral,
  Task,
  Transaction,
  User,
  Wallet,
} from "./types";

export type {
  DemoState,
  ID,
  OwnedPackage,
  Package,
  Referral,
  ReferralInvitee,
  Task,
  Transaction,
  TransactionKind,
  TransactionStatus,
  User,
  Wallet,
} from "./types";

/**
 * Fixed anchor used for the server render so the markup is byte-identical on
 * first client paint (no hydration mismatch). The store re-seeds from the real
 * clock once it mounts on the client.
 */
export const SEED_NOW = "2026-09-23T10:30:00.000Z";

/**
 * The published tier table, exactly as supplied. Every derived figure
 * (net return, per-day totals) is computed here rather than typed twice, so the
 * card, the table and the detail page can never disagree.
 */
const TIER_ROWS: Array<
  Pick<
    Package,
    "price" | "days" | "dailyEarnings" | "taskCost" | "tasksPerDay" | "totalReturn" | "netProfit"
  >
> = [
  { price: 800, days: 14, dailyEarnings: 72, taskCost: 18, tasksPerDay: 4, totalReturn: 1008, netProfit: 208 },
  { price: 2500, days: 20, dailyEarnings: 225, taskCost: 26, tasksPerDay: 8, totalReturn: 4500, netProfit: 2000 },
  { price: 5000, days: 30, dailyEarnings: 450, taskCost: 39, tasksPerDay: 11, totalReturn: 13500, netProfit: 8500 },
  { price: 7500, days: 50, dailyEarnings: 675, taskCost: 64, tasksPerDay: 10, totalReturn: 33750, netProfit: 26250 },
  { price: 12000, days: 60, dailyEarnings: 1080, taskCost: 77, tasksPerDay: 14, totalReturn: 64800, netProfit: 52800 },
  { price: 15000, days: 80, dailyEarnings: 1350, taskCost: 103, tasksPerDay: 13, totalReturn: 108000, netProfit: 93000 },
  { price: 20000, days: 120, dailyEarnings: 1800, taskCost: 154, tasksPerDay: 11, totalReturn: 216000, netProfit: 196000 },
  { price: 30000, days: 160, dailyEarnings: 2700, taskCost: 206, tasksPerDay: 13, totalReturn: 432000, netProfit: 402000 },
  { price: 50000, days: 190, dailyEarnings: 4500, taskCost: 244, tasksPerDay: 18, totalReturn: 855000, netProfit: 805000 },
  { price: 70000, days: 200, dailyEarnings: 6300, taskCost: 257, tasksPerDay: 24, totalReturn: 1260000, netProfit: 1190000 },
];

export const PACKAGES: Package[] = TIER_ROWS.map((row) => ({
  ...row,
  id: `pkg-${row.price}`,
  name: `Package ${row.price.toLocaleString("en-KE")}`,
  currency: "KES",
  netReturnPct: Math.round((row.netProfit / row.price) * 100),
}));

export const getPackage = (id: ID | undefined): Package | undefined =>
  PACKAGES.find((p) => p.id === id);

/** The cheapest tier — used for the "starting package" summary card. */
export const STARTING_PACKAGE = PACKAGES[0];
/** The most expensive tier — the headline summary card. */
export const TOP_TIER_PACKAGE = PACKAGES[PACKAGES.length - 1];

export const MAX_NET_PROFIT = PACKAGES.reduce((max, p) => Math.max(max, p.netProfit), 0);
export const MAX_NET_RETURN_PCT = PACKAGES.reduce((max, p) => Math.max(max, p.netReturnPct), 0);

const TASK_SEEDS: Array<{ packageId: ID; videoLabel: string; durationSeconds: number }> = [
  { packageId: "pkg-800", videoLabel: "Brand awareness — 15s spot", durationSeconds: 30 },
  { packageId: "pkg-800", videoLabel: "Product walkthrough", durationSeconds: 30 },
  { packageId: "pkg-800", videoLabel: "Short-form ad reel", durationSeconds: 30 },
  { packageId: "pkg-800", videoLabel: "Retail promo clip", durationSeconds: 30 },
  { packageId: "pkg-2500", videoLabel: "Mobile app teaser", durationSeconds: 45 },
  { packageId: "pkg-2500", videoLabel: "Customer testimonial", durationSeconds: 45 },
  { packageId: "pkg-2500", videoLabel: "Seasonal campaign cut", durationSeconds: 45 },
  { packageId: "pkg-5000", videoLabel: "Documentary excerpt", durationSeconds: 60 },
  { packageId: "pkg-5000", videoLabel: "Long-form brand story", durationSeconds: 60 },
  { packageId: "pkg-7500", videoLabel: "Sponsorship segment", durationSeconds: 60 },
  { packageId: "pkg-12000", videoLabel: "Premium showcase", durationSeconds: 75 },
  { packageId: "pkg-20000", videoLabel: "Launch event feature", durationSeconds: 90 },
];

/**
 * Tasks inherit their reward from the tier they belong to, so a reward can be
 * shown next to the price it was derived from and never drifts out of sync.
 */
export const TASKS: Task[] = TASK_SEEDS.map((seed, index) => {
  const tier = getPackage(seed.packageId) ?? PACKAGES[0];
  return {
    id: `task-${String(index + 1).padStart(2, "0")}`,
    packageId: tier.id,
    title: `Watch Video Task #${String(index + 1).padStart(2, "0")}`,
    reward: tier.taskCost,
    durationSeconds: seed.durationSeconds,
    videoLabel: seed.videoLabel,
  };
});

export const getTask = (id: ID | undefined): Task | undefined =>
  TASKS.find((t) => t.id === id);

/** Rewards a tier unlocks — used on the Watch screen and the package detail page. */
export const tasksForPackage = (packageId: ID): Task[] =>
  TASKS.filter((t) => t.packageId === packageId);

/**
 * How many tasks the user may be paid for in a day: the quota of the best
 * active tier. With nothing active, nothing is claimable.
 */
export const DEFAULT_FALLBACK_QUOTA = 4;

const hoursBefore = (base: Date, hours: number) =>
  new Date(base.getTime() - hours * 3_600_000).toISOString();

const SEEDED_USER: User = {
  id: "usr-demo-001",
  name: "Amina Wanjiru",
  email: "demo@taskcashpro.app",
  phone: "0712 345 678",
  avatarInitials: "AW",
  accountStatus: "verified",
  joinedAt: "2026-09-20T09:15:00.000Z",
};

const SEEDED_REFERRAL: Referral = {
  code: "TASK12345",
  totalReferrals: 6,
  activeReferrals: 4,
  earnings: 450,
  invitees: [
    { id: "ref-1", name: "Brian M.", joinedAt: "2026-09-22T18:12:00.000Z", status: "active", earned: 150 },
    { id: "ref-2", name: "Grace N.", joinedAt: "2026-09-22T09:40:00.000Z", status: "active", earned: 150 },
    { id: "ref-3", name: "Peter A.", joinedAt: "2026-09-21T20:05:00.000Z", status: "active", earned: 100 },
    { id: "ref-4", name: "Mercy M.", joinedAt: "2026-09-21T13:26:00.000Z", status: "active", earned: 50 },
    { id: "ref-5", name: "Duncan O.", joinedAt: "2026-09-23T07:02:00.000Z", status: "pending", earned: 0 },
    { id: "ref-6", name: "Sarah K.", joinedAt: "2026-09-23T08:55:00.000Z", status: "pending", earned: 0 },
  ],
};

/**
 * Builds a complete demo account.
 *
 * Pass a real `Date` on the client to get a fresh, plausible account; the fixed
 * default keeps the server render deterministic.
 */
export function createInitialDemoState(now: Date = new Date(SEED_NOW)): DemoState {
  const wallet: Wallet = { available: 1240.5, locked: 500 };

  /* Seeded withdrawals go through the same quote as a live request, so the
     history can never show a fee the form would not have charged. */
  const pendingQuote = quoteWithdrawal(500);
  const settledQuote = quoteWithdrawal(300);

  const transactions: Transaction[] = [
    {
      id: "txn-1",
      kind: "task_reward",
      title: "Watch Video Task #02",
      amount: 18,
      status: "completed",
      createdAt: hoursBefore(now, 1.5),
      method: "Task reward",
    },
    {
      id: "txn-2",
      kind: "withdrawal",
      title: "Withdrawal to M-PESA",
      amount: pendingQuote.gross,
      fee: pendingQuote.fee,
      net: pendingQuote.net,
      status: "pending",
      createdAt: hoursBefore(now, 4),
      method: "M-PESA",
      reference: "WD-88214",
    },
    {
      id: "txn-3",
      kind: "bonus",
      title: "Referral bonus — Brian M.",
      amount: 150,
      status: "completed",
      createdAt: hoursBefore(now, 9),
      method: "Referral",
    },
    {
      id: "txn-4",
      kind: "deposit",
      title: "Deposit via M-PESA",
      amount: 2500,
      status: "completed",
      createdAt: hoursBefore(now, 15),
      method: "M-PESA",
      reference: "QK7T2M91AZ",
    },
    {
      id: "txn-5",
      kind: "package_activation",
      title: "Activated Package 800",
      amount: 800,
      status: "completed",
      createdAt: hoursBefore(now, 23),
      method: "M-PESA",
      reference: "PKG-80000",
    },
    {
      id: "txn-6",
      kind: "task_reward",
      title: "Watch Video Task #01",
      amount: 18,
      status: "completed",
      createdAt: hoursBefore(now, 24),
      method: "Task reward",
    },
    {
      id: "txn-7",
      kind: "deposit",
      title: "Deposit via M-PESA",
      amount: 1000,
      status: "failed",
      createdAt: hoursBefore(now, 38),
      method: "M-PESA",
      reference: "QK4B8N11XC",
    },
    {
      id: "txn-8",
      kind: "bonus",
      title: "Welcome bonus",
      amount: 50,
      status: "completed",
      createdAt: hoursBefore(now, 49),
      method: "Promotion",
    },
    {
      id: "txn-9",
      kind: "withdrawal",
      title: "Withdrawal to M-PESA",
      amount: settledQuote.gross,
      fee: settledQuote.fee,
      net: settledQuote.net,
      status: "completed",
      createdAt: hoursBefore(now, 56),
      method: "M-PESA",
      reference: "WD-88102",
    },
  ];

  return {
    user: SEEDED_USER,
    wallet,
    packages: [
      {
        packageId: "pkg-800",
        activatedAt: hoursBefore(now, 23),
        expiresAt: new Date(now.getTime() + 13 * 86_400_000).toISOString(),
      },
    ],
    transactions,
    referral: SEEDED_REFERRAL,
    claimedTaskIds: ["task-01", "task-02"],
    claimedTodayCount: 2,
  };
}

/** Convenience for the login screen's "use demo account" affordance. */
export const DEMO_CREDENTIALS = {
  email: "demo@taskcashpro.app",
  password: "taskcash",
} as const;
