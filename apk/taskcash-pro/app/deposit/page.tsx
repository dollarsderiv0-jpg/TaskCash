"use client";

import * as React from "react";
import { AlertTriangle, Check, Smartphone } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Modal } from "@/components/modal";
import { PageHeader } from "@/components/page-header";
import { PrimaryButton } from "@/components/primary-button";
import { StatCard } from "@/components/stat-card";
import { useToast } from "@/components/toast";
import { cn, formatMoney, formatMoneyCompact } from "@/lib/format";
import { useStore } from "@/lib/store";

const PRESETS = [500, 1000, 2500, 5000];

export default function DepositPage() {
  const { state, deposit } = useStore();
  const toast = useToast();

  const [amount, setAmount] = React.useState("1000");
  const [method] = React.useState("M-PESA");
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const parsed = Number(amount.replace(/[,\s]/g, ""));

  const handleContinue = (event: React.FormEvent) => {
    event.preventDefault();
    if (!Number.isFinite(parsed) || parsed < 100) {
      setError("Minimum deposit is KES 100.");
      return;
    }
    setError(null);
    setConfirming(true);
  };

  const handleConfirm = () => {
    setBusy(true);
    window.setTimeout(() => {
      const result = deposit(parsed, method);
      setBusy(false);
      setConfirming(false);
      if (!result.ok) {
        setError(result.message ?? "Deposit failed.");
        return;
      }
      toast.success("Deposit simulated", `${formatMoneyCompact(parsed)} added to your balance.`);
      setAmount("1000");
    }, 600);
  };

  return (
    <AppShell>
      <PageHeader
        title="Deposit"
        subtitle="Top up your demo wallet so you can activate a package and run a full flow."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Available" value={formatMoneyCompact(state.wallet.available)} tone="positive" />
        <StatCard label="Locked" value={formatMoneyCompact(state.wallet.locked)} tone="accent" />
        <StatCard
          label="Total deposited"
          value={formatMoneyCompact(
            state.transactions
              .filter((t) => t.kind === "deposit" && t.status === "completed")
              .reduce((sum, t) => sum + t.amount, 0),
          )}
          className="col-span-2 sm:col-span-1"
        />
      </div>

      <form onSubmit={handleContinue} className="tc-card mt-4 p-4 sm:p-5">
        <div>
          <label htmlFor="deposit-amount" className="mb-1.5 block text-[13px] font-semibold text-white">
            Amount (KES)
          </label>
          <input
            id="deposit-amount"
            inputMode="numeric"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="1,000"
            className="tnum h-11 w-full rounded-tile border border-hairline bg-base/70 px-3 text-sm text-white placeholder:text-muted/70 focus:border-flame/60 focus:outline-none focus:ring-2 focus:ring-flame/25"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setAmount(String(preset))}
                className={cn(
                  "tnum rounded-full border px-3 py-1.5 text-[12px] font-semibold transition",
                  parsed === preset
                    ? "border-flame bg-flame/15 text-white"
                    : "border-hairline bg-base/50 text-muted hover:border-flame/50 hover:text-white",
                )}
              >
                {formatMoneyCompact(preset)}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <span className="mb-1.5 block text-[13px] font-semibold text-white">Payment method</span>
          <div className="flex items-center justify-between gap-3 rounded-tile border border-cash/40 bg-cash/[0.07] px-3.5 py-3">
            <span className="flex items-center gap-2.5">
              <Smartphone className="h-4 w-4 text-cash" aria-hidden />
              <span className="text-[13px] font-semibold text-white">{method}</span>
            </span>
            <span className="grid h-5 w-5 place-items-center rounded-full bg-cash text-base">
              <Check className="h-3.5 w-3.5" aria-hidden />
            </span>
          </div>
          <p className="mt-1 text-[11px] text-muted">
            Mobile money is the only enabled channel in this prototype.
          </p>
        </div>

        {error ? (
          <p role="alert" className="mt-3 rounded-tile border border-flame/40 bg-flame/10 px-3 py-2 text-xs text-flame-400">
            {error}
          </p>
        ) : null}

        <div className="mt-4">
          <PrimaryButton type="submit" variant="flame" size="lg" full>
            Continue
          </PrimaryButton>
        </div>
      </form>

      <div className="mt-4 flex items-start gap-2.5 rounded-tile border border-flame/35 bg-flame/[0.08] px-3.5 py-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-flame-400" aria-hidden />
        <p className="text-[11px] leading-relaxed text-flame-400">
          <span className="font-bold">Demo Mode.</span> No STK push is sent, no payment is collected
          and no real money is involved. Confirming simply increments the mock balance stored in this
          browser.
        </p>
      </div>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Confirm deposit"
        description="This is a simulated top-up."
        footer={
          <div className="flex gap-2">
            <PrimaryButton variant="ghost" full size="lg" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </PrimaryButton>
            <PrimaryButton full size="lg" loading={busy} onClick={handleConfirm}>
              Confirm
            </PrimaryButton>
          </div>
        }
      >
        <div className="rounded-tile border border-hairline bg-base/50 px-3.5 py-3">
          <div className="tc-row">
            <span className="tc-row-label">Amount</span>
            <span className="tnum tc-row-value">{formatMoney(Number.isFinite(parsed) ? parsed : 0)}</span>
          </div>
          <div className="tc-row">
            <span className="tc-row-label">Method</span>
            <span className="tc-row-value">{method}</span>
          </div>
          <div className="tc-row">
            <span className="tc-row-label">Number</span>
            <span className="tnum tc-row-value">{state.user.phone}</span>
          </div>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-muted">
          You will not be charged. The mock balance updates immediately so you can continue to the
          package flow.
        </p>
      </Modal>
    </AppShell>
  );
}
