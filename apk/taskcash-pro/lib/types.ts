/**
 * Domain types for the TaskCash Pro prototype.
 *
 * These describe the *shape* the real product would need, so the components can
 * be swapped onto a live API later without a rewrite. Nothing here talks to a
 * backend — see `mock-data.ts` for the seed values.
 */

export type ID = string;

export interface User {
  id: ID;
  name: string;
  email: string;
  phone: string;
  avatarInitials: string;
  /** "verified" drives the green account badge. */
  accountStatus: "verified" | "pending";
  joinedAt: string;
}

export interface Package {
  id: ID;
  name: string;
  price: number;
  currency: "KES";
  days: number;
  dailyEarnings: number;
  /** What a single task on this tier pays. */
  taskCost: number;
  tasksPerDay: number;
  totalReturn: number;
  netProfit: number;
  /** netProfit / price, expressed as a percentage. */
  netReturnPct: number;
}

/** A package the signed-in user has activated. */
export interface OwnedPackage {
  packageId: ID;
  activatedAt: string;
  /** ISO timestamp; the browser clock is never trusted for expiry. */
  expiresAt: string;
}

export interface Task {
  id: ID;
  /** Tier this task belongs to — its reward mirrors that tier's taskCost. */
  packageId: ID;
  title: string;
  reward: number;
  durationSeconds: number;
  videoLabel: string;
}

export type TransactionKind =
  | "task_reward"
  | "package_activation"
  | "deposit"
  | "withdrawal"
  | "bonus";

export type TransactionStatus = "completed" | "pending" | "failed";

export interface Transaction {
  id: ID;
  kind: TransactionKind;
  title: string;
  /**
   * Always positive. For a withdrawal this is the gross the user requested and
   * that left their available balance; see `fee` and `net` for what they receive.
   * Direction is derived from `kind` via `isCredit`.
   */
  amount: number;
  status: TransactionStatus;
  createdAt: string;
  method?: string;
  reference?: string;
  /** Withdrawals only: the platform fee deducted from `amount`. */
  fee?: number;
  /** Withdrawals only: what actually reached the user (`amount - fee`). */
  net?: number;
}

export interface Wallet {
  available: number;
  locked: number;
}

export interface ReferralInvitee {
  id: ID;
  name: string;
  joinedAt: string;
  status: "active" | "pending";
  earned: number;
}

export interface Referral {
  code: string;
  totalReferrals: number;
  activeReferrals: number;
  earnings: number;
  invitees: ReferralInvitee[];
}

/** Everything the prototype persists to localStorage. */
export interface DemoState {
  user: User;
  wallet: Wallet;
  packages: OwnedPackage[];
  transactions: Transaction[];
  referral: Referral;
  /** Task ids already paid out, so a reward can never be claimed twice. */
  claimedTaskIds: ID[];
  /** How many rewards were claimed today, against the active tier's quota. */
  claimedTodayCount: number;
}
