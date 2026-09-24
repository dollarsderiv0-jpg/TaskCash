"use client";

import * as React from "react";
import { AlertTriangle, Smartphone } from "lucide-react";
import { formatMoney } from "@/lib/format";
import type { Package } from "@/lib/types";
import { useStore } from "@/lib/store";
import { useToast } from "./toast";
import { Modal } from "./modal";
import { PrimaryButton } from "./primary-button";

type Step = "phone" | "confirm";

/**
 * Mock checkout for a tier.
 *
 * Two explicit steps, and activation only happens on the second one — the
 * prototype is shaped like the real flow even though the balance is fake, so
 * the confirmation copy can be reviewed as it would ship.
 */
export function PurchaseModal({
  pkg,
  onClose,
}: {
  pkg: Package | null;
  onClose: () => void;
}) {
  const { activatePackage, state, totalBalance } = useStore();
  const toast = useToast();
  const [step, setStep] = React.useState<Step>("phone");
  const [phone, setPhone] = React.useState(state.user.phone.replace(/\s/g, ""));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /* Reset the wizard whenever a different tier is opened. */
  React.useEffect(() => {
    if (pkg) {
      setStep("phone");
      setError(null);
      setBusy(false);
    }
  }, [pkg]);

  if (!pkg) return null;

  const normalised = phone.replace(/\s/g, "");
  const phoneValid = /^0[17]\d{8}$/.test(normalised);

  const confirm = () => {
    setBusy(true);
    window.setTimeout(() => {
      const result = activatePackage(pkg.id);
      setBusy(false);
      if (!result.ok) {
        setError(result.message ?? "Activation failed.");
        return;
      }
      toast.success(`${pkg.name} activated`, "Watch & Earn has been unlocked for this tier.");
      onClose();
    }, 600);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={step === "phone" ? `Buy ${pkg.name}` : "Confirm payment"}
      description={
        step === "phone"
          ? "Enter the M-PESA number that should be charged."
          : "Check the details below before you continue."
      }
      footer={
        step === "phone" ? (
          <PrimaryButton
            full
            size="lg"
            disabled={!phoneValid}
            onClick={() => setStep("confirm")}
          >
            Confirm &amp; Pay
          </PrimaryButton>
        ) : (
          <div className="flex gap-2">
            <PrimaryButton variant="ghost" full size="lg" onClick={() => setStep("phone")} disabled={busy}>
              Cancel
            </PrimaryButton>
            <PrimaryButton full size="lg" loading={busy} onClick={confirm}>
              Confirm &amp; Pay
            </PrimaryButton>
          </div>
        )
      }
    >
      {step === "phone" ? (
        <div className="space-y-3.5">
          <div className="flex items-center justify-between rounded-tile border border-hairline bg-base/50 px-3.5 py-3">
            <span className="tc-label">Package price</span>
            <span className="tnum text-lg font-extrabold text-white">{formatMoney(pkg.price)}</span>
          </div>

          <div>
            <label htmlFor="buy-phone" className="mb-1.5 block text-[13px] font-semibold text-white">
              M-Pesa phone number
            </label>
            <div className="relative">
              <Smartphone
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
                aria-hidden
              />
              <input
                id="buy-phone"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="0712 345 678"
                className="tnum h-11 w-full rounded-tile border border-hairline bg-base/70 pl-9 pr-3 text-sm text-white placeholder:text-muted/70 focus:border-flame/60 focus:outline-none focus:ring-2 focus:ring-flame/25"
              />
            </div>
            <p className="mt-1 text-[11px] text-muted">
              Format 07XXXXXXXX or 01XXXXXXXX. The number is validated before you can continue.
            </p>
          </div>

          <p className="text-[11px] leading-relaxed text-muted">
            Wallet balance <span className="tnum font-semibold text-white">{formatMoney(totalBalance)}</span> ·
            Available <span className="tnum font-semibold text-cash">{formatMoney(state.wallet.available)}</span>
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-white">
            You are about to pay <span className="tnum font-bold">{formatMoney(pkg.price)}</span> using
            M-Pesa.
          </p>
          <div className="rounded-tile border border-hairline bg-base/50 px-3.5 py-3">
            <div className="tc-row">
              <span className="tc-row-label">Phone number</span>
              <span className="tnum tc-row-value">{normalised}</span>
            </div>
            <div className="tc-row">
              <span className="tc-row-label">Package</span>
              <span className="tc-row-value">{pkg.name}</span>
            </div>
            <div className="tc-row">
              <span className="tc-row-label">Duration</span>
              <span className="tc-row-value">{pkg.days} days</span>
            </div>
          </div>

          <div className="flex items-start gap-2.5 rounded-tile border border-flame/35 bg-flame/[0.08] px-3 py-2.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-flame-400" aria-hidden />
            <p className="text-[11px] leading-relaxed text-flame-400">
              Demo mode — no STK push is sent and no real payment is taken. Activation is simulated
              from your mock wallet balance.
            </p>
          </div>

          {error ? (
            <p role="alert" className="rounded-tile border border-flame/40 bg-flame/10 px-3 py-2 text-xs text-flame-400">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
