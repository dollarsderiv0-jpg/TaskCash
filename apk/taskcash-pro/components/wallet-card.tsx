"use client";

import * as React from "react";
import { ArrowUpFromLine, Info } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { WITHDRAWAL_FEE_PCT, quoteWithdrawal, type WithdrawalQuote } from "@/lib/fees";
import type { ActionResult } from "@/lib/store";
import { PrimaryButton } from "./primary-button";

/**
 * The cashout form.
 *
 * The fee is previewed live rather than sprung at the last step: the user sees
 * exactly what leaves their balance, what the fee is, and what they will
 * actually receive before they commit. Validation feedback stays inline so a
 * rejected amount is visible next to the field it belongs to.
 */
export function WalletCard({
  available,
  defaultPhone,
  onSubmit,
}: {
  available: number;
  defaultPhone?: string;
  onSubmit: (amount: number, phone: string) => ActionResult & { quote?: WithdrawalQuote };
}) {
  const [phone, setPhone] = React.useState(defaultPhone ?? "");
  const [amount, setAmount] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const parsed = Number(amount.replace(/[,\s]/g, ""));
  const quote = quoteWithdrawal(Number.isFinite(parsed) ? parsed : 0);
  const showQuote = quote.gross >= 100;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    /* A short delay so the pending state is actually perceptible. */
    window.setTimeout(() => {
      const result = onSubmit(parsed, phone);
      setError(result.ok ? null : (result.message ?? "Something went wrong."));
      if (result.ok) setAmount("");
      setBusy(false);
    }, 420);
  };

  return (
    <form onSubmit={handleSubmit} className="tc-card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold tracking-tight text-white">Instant Cashout</h2>
          <p className="mt-0.5 text-xs text-muted">
            Available <span className="tnum font-semibold text-cash">{formatMoney(available)}</span>
          </p>
        </div>
        <span className="grid h-9 w-9 place-items-center rounded-tile border border-hairline bg-raised text-flame-400">
          <ArrowUpFromLine className="h-4 w-4" aria-hidden />
        </span>
      </div>

      <div className="mt-3 flex items-start gap-2.5 rounded-tile border border-flame/35 bg-flame/[0.08] px-3 py-2.5">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-flame-400" aria-hidden />
        <p className="text-[11px] leading-relaxed text-flame-400">
          A <span className="font-bold">{WITHDRAWAL_FEE_PCT}% withdrawal fee</span> applies to every
          cashout. The fee is taken from the amount you request.
        </p>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <label htmlFor="cashout-phone" className="mb-1.5 block text-[13px] font-semibold text-white">
            Mobile Money Number
          </label>
          <input
            id="cashout-phone"
            name="phone"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="0712 345 678"
            className="tnum h-11 w-full rounded-tile border border-hairline bg-base/70 px-3 text-sm text-white placeholder:text-muted/70 focus:border-flame/60 focus:outline-none focus:ring-2 focus:ring-flame/25"
          />
        </div>

        <div>
          <label htmlFor="cashout-amount" className="mb-1.5 block text-[13px] font-semibold text-white">
            Amount (KES)
          </label>
          <div className="relative">
            <input
              id="cashout-amount"
              name="amount"
              inputMode="numeric"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="1,000"
              className="tnum h-11 w-full rounded-tile border border-hairline bg-base/70 px-3 pr-16 text-sm text-white placeholder:text-muted/70 focus:border-flame/60 focus:outline-none focus:ring-2 focus:ring-flame/25"
            />
            <button
              type="button"
              onClick={() => setAmount(String(available))}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-flame-400 transition hover:bg-flame/10"
            >
              Max
            </button>
          </div>
          <p className="mt-1 text-[11px] text-muted">
            Minimum KES 100. Pending requests are held until an admin approves them.
          </p>
        </div>
      </div>

      {/* Live breakdown — only once the amount is big enough to be valid. */}
      {showQuote ? (
        <div className="mt-3 rounded-tile border border-hairline bg-base/50 px-3.5 py-1">
          <div className="tc-row">
            <span className="tc-row-label">Amount requested</span>
            <span className="tnum tc-row-value">{formatMoney(quote.gross)}</span>
          </div>
          <div className="tc-row">
            <span className="tc-row-label">Withdrawal fee ({WITHDRAWAL_FEE_PCT}%)</span>
            <span className="tnum tc-row-value text-flame-400">−{formatMoney(quote.fee)}</span>
          </div>
          <div className="tc-row">
            <span className="tc-row-label">You receive</span>
            <span className="tnum tc-row-value text-cash">{formatMoney(quote.net)}</span>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 rounded-tile border border-flame/40 bg-flame/10 px-3 py-2 text-xs text-flame-400">
          {error}
        </p>
      ) : null}

      <div className="mt-4">
        <PrimaryButton type="submit" variant="flame" full size="lg" loading={busy}>
          Request Withdrawal
        </PrimaryButton>
      </div>

      <p className="mt-2.5 text-center text-[10px] leading-snug text-muted/80">
        Demo only — no transfer is initiated and no funds leave the prototype.
      </p>
    </form>
  );
}
