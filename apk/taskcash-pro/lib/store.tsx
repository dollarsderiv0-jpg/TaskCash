"use client";

import * as React from "react";
import { quoteWithdrawal, type WithdrawalQuote } from "./fees";
import { createInitialDemoState, getPackage, getTask } from "./mock-data";
import type { DemoState, ID, OwnedPackage, Transaction } from "./types";

/**
 * All prototype state lives in one provider backed by localStorage.
 *
 * The guard rails that matter are modelled honestly even though the money is
 * fake: a reward cannot be claimed twice, a daily quota is enforced, a
 * withdrawal cannot exceed the available balance, and a package only becomes
 * active once it has actually been paid for out of that balance.
 */

const STATE_KEY = "taskcash-pro:state:v1";
const SESSION_KEY = "taskcash-pro:session:v1";

/**
 * A client-only, monotonic id. Deliberately not `crypto.randomUUID()`: that is
 * unavailable in some in-app browsers, and this only has to be unique inside a
 * single demo session.
 */
let seq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq += 1)}`;

const MIN_WITHDRAWAL = 100;

export interface ActionResult {
  ok: boolean;
  message?: string;
}

interface StoreValue {
  /** False until localStorage has been read, so guards don't fire on stale state. */
  ready: boolean;
  authed: boolean;
  state: DemoState;

  /* Derived once here so no two screens can disagree about the same figure. */
  totalBalance: number;
  activePackages: Array<OwnedPackage & { name: string; days: number }>;
  expiredPackages: Array<OwnedPackage & { name: string; days: number }>;
  /** Paid tasks allowed per day, from the best active tier. */
  dailyQuota: number;
  claimedToday: number;
  quotaRemaining: number;
  packageEarnings: number;
  todayEarnings: number;
  completedTaskCount: number;

  login: (email: string, password: string) => ActionResult;
  logout: () => void;
  activatePackage: (packageId: ID) => ActionResult;
  claimTask: (taskId: ID) => ActionResult & { reward?: number };
  deposit: (amount: number, method: string) => ActionResult;
  requestWithdrawal: (amount: number, phone: string) => ActionResult & { quote?: WithdrawalQuote };
  updateProfile: (patch: Partial<Pick<DemoState["user"], "name" | "email" | "phone">>) => void;
  resetDemo: () => void;
}

const StoreContext = React.createContext<StoreValue | null>(null);

const hasExpired = (p: OwnedPackage, now: number) => new Date(p.expiresAt).getTime() <= now;

export function DemoStoreProvider({ children }: { children: React.ReactNode }) {
  /* Deterministic first render — identical output on the server and in the browser. */
  const [state, setState] = React.useState<DemoState>(() => createInitialDemoState());
  const [authed, setAuthed] = React.useState(false);
  const [ready, setReady] = React.useState(false);

  /**
   * `setState` with an updater does not run synchronously, so an action could
   * not both validate and mutate in one pass through it. This ref is advanced
   * immediately, which makes each action a single atomic step and keeps
   * back-to-back calls (a double-clicked button) from acting on stale data.
   */
  const stateRef = React.useRef(state);

  const apply = React.useCallback((next: DemoState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const commit = React.useCallback(
    (reduce: (prev: DemoState) => DemoState) => {
      apply(reduce(stateRef.current));
    },
    [apply],
  );

  /* Once mounted, prefer a stored session; otherwise seed a fresh account from
     the real clock so the demo always looks recently used. */
  React.useEffect(() => {
    let restored: DemoState | null = null;
    try {
      const raw = window.localStorage.getItem(STATE_KEY);
      if (raw) restored = JSON.parse(raw) as DemoState;
    } catch {
      restored = null;
    }
    apply(restored ?? createInitialDemoState(new Date()));

    try {
      setAuthed(window.localStorage.getItem(SESSION_KEY) === "1");
    } catch {
      setAuthed(false);
    }
    setReady(true);
  }, [apply]);

  React.useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch {
      /* Storage full or blocked (private mode) — the demo still works in memory. */
    }
  }, [state, ready]);

  const persistSession = React.useCallback((value: boolean) => {
    try {
      if (value) window.localStorage.setItem(SESSION_KEY, "1");
      else window.localStorage.removeItem(SESSION_KEY);
    } catch {
      /* Non-fatal. */
    }
  }, []);

  const login = React.useCallback(
    (email: string, password: string): ActionResult => {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
        return { ok: false, message: "Enter a valid email address." };
      }
      if (password.length < 4) {
        return { ok: false, message: "Password must be at least 4 characters." };
      }
      setAuthed(true);
      persistSession(true);
      return { ok: true };
    },
    [persistSession],
  );

  const logout = React.useCallback(() => {
    setAuthed(false);
    persistSession(false);
  }, [persistSession]);

  const activatePackage = React.useCallback(
    (packageId: ID): ActionResult => {
      const tier = getPackage(packageId);
      if (!tier) return { ok: false, message: "Unknown package." };

      const prev = stateRef.current;
      const now = Date.now();
      if (prev.packages.some((p) => p.packageId === packageId && !hasExpired(p, now))) {
        return { ok: false, message: `${tier.name} is already active.` };
      }
      if (prev.wallet.available < tier.price) {
        return { ok: false, message: "Available balance is too low. Make a deposit first." };
      }

      const entry: Transaction = {
        id: nextId("txn"),
        kind: "package_activation",
        title: `Activated ${tier.name}`,
        amount: tier.price,
        status: "completed",
        createdAt: new Date(now).toISOString(),
        method: "Wallet balance",
        reference: `PKG-${tier.price}`,
      };

      commit((p) => ({
        ...p,
        wallet: { ...p.wallet, available: p.wallet.available - tier.price },
        packages: [
          ...p.packages.filter((owned) => owned.packageId !== packageId),
          {
            packageId,
            activatedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + tier.days * 86_400_000).toISOString(),
          },
        ],
        transactions: [entry, ...p.transactions],
      }));

      return { ok: true };
    },
    [commit],
  );

  const claimTask = React.useCallback(
    (taskId: ID): ActionResult & { reward?: number } => {
      const task = getTask(taskId);
      if (!task) return { ok: false, message: "Unknown task." };

      const prev = stateRef.current;
      if (prev.claimedTaskIds.includes(taskId)) {
        return { ok: false, message: "This reward has already been claimed." };
      }

      const now = Date.now();
      const active = prev.packages.filter((p) => !hasExpired(p, now));
      if (active.length === 0) {
        return { ok: false, message: "Activate a package to start earning." };
      }
      const quota = active.reduce(
        (max, p) => Math.max(max, getPackage(p.packageId)?.tasksPerDay ?? 0),
        0,
      );
      if (prev.claimedTodayCount >= quota) {
        return { ok: false, message: `Daily quota of ${quota} tasks reached. Come back tomorrow.` };
      }

      const entry: Transaction = {
        id: nextId("txn"),
        kind: "task_reward",
        title: task.title,
        amount: task.reward,
        status: "completed",
        createdAt: new Date(now).toISOString(),
        method: "Task reward",
      };

      commit((p) => ({
        ...p,
        wallet: { ...p.wallet, available: p.wallet.available + task.reward },
        transactions: [entry, ...p.transactions],
        claimedTaskIds: [...p.claimedTaskIds, taskId],
        claimedTodayCount: p.claimedTodayCount + 1,
      }));

      return { ok: true, reward: task.reward };
    },
    [commit],
  );

  const deposit = React.useCallback(
    (amount: number, method: string): ActionResult => {
      if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, message: "Enter an amount greater than zero." };
      }
      if (amount < 100) return { ok: false, message: "Minimum deposit is KES 100." };

      const entry: Transaction = {
        id: nextId("txn"),
        kind: "deposit",
        title: `Deposit via ${method}`,
        amount,
        status: "completed",
        createdAt: new Date().toISOString(),
        method,
        reference: `DM-${Math.floor(100000 + Math.random() * 899999)}`,
      };

      commit((p) => ({
        ...p,
        wallet: { ...p.wallet, available: p.wallet.available + amount },
        transactions: [entry, ...p.transactions],
      }));

      return { ok: true };
    },
    [commit],
  );

  const requestWithdrawal = React.useCallback(
    (amount: number, phone: string): ActionResult & { quote?: WithdrawalQuote } => {
      if (!/^0[17]\d{8}$/.test(phone.replace(/\s/g, ""))) {
        return { ok: false, message: "Enter a valid M-PESA number, e.g. 0712345678." };
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, message: "Enter an amount greater than zero." };
      }
      if (amount < MIN_WITHDRAWAL) {
        return { ok: false, message: `Minimum withdrawal is KES ${MIN_WITHDRAWAL}.` };
      }
      if (amount > stateRef.current.wallet.available) {
        return { ok: false, message: "Amount exceeds your available balance." };
      }

      /* The 10% fee comes out of the request, so the payout is the remainder.
         Quoted through `fees.ts` so the ledger, the form preview and the
         confirmation panel can never disagree about it. */
      const quote = quoteWithdrawal(amount);
      if (quote.net <= 0) {
        return { ok: false, message: "The withdrawal fee would consume this whole amount." };
      }

      const entry: Transaction = {
        id: nextId("txn"),
        kind: "withdrawal",
        title: "Withdrawal to M-PESA",
        amount: quote.gross,
        fee: quote.fee,
        net: quote.net,
        status: "pending",
        createdAt: new Date().toISOString(),
        method: "M-PESA",
        reference: `WD-${Math.floor(100000 + Math.random() * 899999)}`,
      };

      commit((p) => ({
        ...p,
        /* The full gross is held while pending — the payout goes to the user and
           the fee is retained — so `locked` moves by the gross, not the net. */
        wallet: {
          ...p.wallet,
          available: p.wallet.available - quote.gross,
          locked: p.wallet.locked + quote.gross,
        },
        transactions: [entry, ...p.transactions],
      }));

      return { ok: true, quote };
    },
    [commit],
  );

  const updateProfile = React.useCallback(
    (patch: Partial<Pick<DemoState["user"], "name" | "email" | "phone">>) => {
      commit((prev) => {
        const name = patch.name ?? prev.user.name;
        const initials =
          name
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part[0]?.toUpperCase() ?? "")
            .join("") || prev.user.avatarInitials;
        return { ...prev, user: { ...prev.user, ...patch, name, avatarInitials: initials } };
      });
    },
    [commit],
  );

  const resetDemo = React.useCallback(() => {
    apply(createInitialDemoState(new Date()));
    persistSession(false);
    setAuthed(false);
    try {
      window.localStorage.removeItem(STATE_KEY);
    } catch {
      /* Non-fatal. */
    }
  }, [apply, persistSession]);

  /* Re-derived on every render: cheap, and it keeps the countdown honest. */
  const now = Date.now();
  const owned = state.packages.map((p) => {
    const tier = getPackage(p.packageId);
    return { ...p, name: tier?.name ?? p.packageId, days: tier?.days ?? 0 };
  });
  const activePackages = owned.filter((p) => !hasExpired(p, now));
  const expiredPackages = owned.filter((p) => hasExpired(p, now));
  const dailyQuota = activePackages.reduce(
    (max, p) => Math.max(max, getPackage(p.packageId)?.tasksPerDay ?? 0),
    0,
  );

  const rewardTxns = state.transactions.filter((t) => t.kind === "task_reward");
  const packageEarnings = rewardTxns.reduce((sum, t) => sum + t.amount, 0);
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const todayEarnings = rewardTxns
    .filter((t) => new Date(t.createdAt).getTime() >= dayStart.getTime())
    .reduce((sum, t) => sum + t.amount, 0);

  const value: StoreValue = {
    ready,
    authed,
    state,
    totalBalance: state.wallet.available + state.wallet.locked,
    activePackages,
    expiredPackages,
    dailyQuota,
    claimedToday: state.claimedTodayCount,
    quotaRemaining: Math.max(0, dailyQuota - state.claimedTodayCount),
    packageEarnings,
    todayEarnings,
    completedTaskCount: state.claimedTaskIds.length,
    login,
    logout,
    activatePackage,
    claimTask,
    deposit,
    requestWithdrawal,
    updateProfile,
    resetDemo,
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = React.useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside <DemoStoreProvider>.");
  return ctx;
}
