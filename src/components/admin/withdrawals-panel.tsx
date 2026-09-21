"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Ban,
  BookOpenCheck,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Send,
  ShieldAlert,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/fields";
import { Card, CardContent } from "@/components/ui/card";
import {
  Alert,
  Badge,
  EmptyState,
  Separator,
  statusBadgeVariant,
} from "@/components/ui/misc";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TBody, TD, TH, THead, TR, Table, TableWrap } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";
import { formatDateTime, formatMoney, relativeTime } from "@/lib/money/format";
import { statusLabel, type FraudEvent, type Profile, type WalletTransaction, type Withdrawal } from "@/lib/types";

/**
 * Withdrawal review.
 *
 * The approve action does NOT mark the withdrawal as paid — it initiates the
 * provider disbursement. The withdrawal is only marked completed once the
 * provider confirms, so nothing in this screen can produce a false "paid"
 * state. High-value approvals additionally require the administrator's own
 * password to be re-verified server-side.
 */

const STATUS_TABS = [
  { value: "PENDING_ADMIN_APPROVAL", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
  { value: "PROCESSING", label: "Processing" },
  { value: "COMPLETED", label: "Completed" },
  { value: "REJECTED", label: "Rejected" },
  { value: "FAILED", label: "Failed" },
  { value: "ALL", label: "All" },
];

type Row = Withdrawal & {
  user: Partial<Profile> | null;
  accountAgeDays: number;
  depositCount: number;
};

type Context = {
  withdrawal: Withdrawal;
  profile: Profile | null;
  wallet: { available_balance: number; locked_balance: number; currency: string } | null;
  deposits: { id: string; amount: number; status: string; created_at: string }[];
  earnings: { type: string; amount: number; status: string; created_at: string }[];
  referrals: { id: string; status: string; created_at: string; qualified_at: string | null }[];
  fraudEvents: FraudEvent[];
  previousWithdrawals: {
    id: string;
    amount: number;
    status: string;
    requested_at: string;
    rejection_reason: string | null;
  }[];
  ledger: WalletTransaction[];
};

export function WithdrawalsPanel({
  highValueThreshold,
  payoutNotice,
  providerLabel,
}: {
  highValueThreshold: number;
  /** Which gateway would send a payout — from the server, so the copy cannot
   *  name a provider the approval route would not use. */
  providerLabel: string;
  /**
   * Set when a real payout cannot be sent yet — no merchant credentials, or a
   * simulator that must not stand in for one. Computed on the server so this
   * screen cannot disagree with what the approval route will actually do.
   */
  payoutNotice: string | null;
}) {
  const { toast } = useToast();

  const [status, setStatus] = React.useState("PENDING_ADMIN_APPROVAL");
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [rows, setRows] = React.useState<Row[]>([]);
  const [totalPages, setTotalPages] = React.useState(1);
  const [total, setTotal] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);

  const [openId, setOpenId] = React.useState<string | null>(null);
  const [context, setContext] = React.useState<Context | null>(null);
  const [contextLoading, setContextLoading] = React.useState(false);

  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [rejectReason, setRejectReason] = React.useState("");
  const [actionLoading, setActionLoading] = React.useState<string | null>(null);

  const [approveOpen, setApproveOpen] = React.useState(false);
  const [adminPassword, setAdminPassword] = React.useState("");
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [approveError, setApproveError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ page: String(page), pageSize: "25", status });
    const response = await apiRequest<{
      items: Row[];
      total: number;
      totalPages: number;
    }>(`/api/admin/withdrawals?${params.toString()}`);

    if (response.ok) {
      setRows(response.data.items);
      setTotalPages(response.data.totalPages);
      setTotal(response.data.total);
    } else {
      setError(response.message);
      setRows([]);
    }
    setLoading(false);
  }, [page, status]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(id: string) {
    setOpenId(id);
    setContext(null);
    setContextLoading(true);
    setApproveError(null);
    setAdminPassword("");
    setAcknowledged(false);

    const response = await apiRequest<Context>(`/api/admin/withdrawals/${id}`);
    if (response.ok) {
      setContext(response.data);
    } else {
      toast({ title: "Could not load details", description: response.message, tone: "error" });
      setOpenId(null);
    }
    setContextLoading(false);
  }

  async function approve() {
    if (!context) return;
    setApproveError(null);
    setActionLoading("approve");

    const requiresPassword = Number(context.withdrawal.amount) >= highValueThreshold;

    const response = await apiRequest<{
      status: string;
      message: string;
      paymentInitiated: boolean;
    }>(`/api/admin/withdrawals/${context.withdrawal.id}/approve`, {
      method: "POST",
      body: {
        acknowledgement: true,
        ...(requiresPassword ? { adminPassword } : {}),
      },
    });

    setActionLoading(null);

    if (!response.ok) {
      setApproveError(response.message);
      return;
    }

    // Driven by whether money was actually sent, not by the status alone: an
    // approval that initiated no payout must never be announced as one.
    const initiated = response.data.paymentInitiated;
    toast({
      title: !initiated
        ? "Approved — no payout sent"
        : response.data.status === "COMPLETED"
          ? "Payout confirmed"
          : response.data.status === "FAILED"
            ? "Payout failed — funds returned"
            : "Payout initiated",
      description: response.data.message,
      tone: !initiated
        ? "warning"
        : response.data.status === "COMPLETED"
          ? "success"
          : response.data.status === "FAILED"
            ? "warning"
            : "info",
    });

    setApproveOpen(false);
    setOpenId(null);
    setContext(null);
    void load();
  }

  async function reject() {
    if (!context) return;
    if (rejectReason.trim().length < 5) {
      toast({ title: "Provide a reason", description: "A rejection reason is required.", tone: "warning" });
      return;
    }

    setActionLoading("reject");
    const response = await apiRequest<{ status: string; message: string }>(
      `/api/admin/withdrawals/${context.withdrawal.id}/reject`,
      { method: "POST", body: { reason: rejectReason.trim() } },
    );
    setActionLoading(null);

    if (!response.ok) {
      toast({ title: "Could not reject", description: response.message, tone: "error" });
      return;
    }

    toast({ title: "Withdrawal rejected", description: response.data.message, tone: "success" });
    setRejectOpen(false);
    setRejectReason("");
    setOpenId(null);
    setContext(null);
    void load();
  }

  async function settle() {
    if (!context) return;
    setActionLoading("settle");
    const response = await apiRequest<{ status: string; message: string }>(
      "/api/payments/sasapay/disburse",
      { method: "POST", body: { withdrawalId: context.withdrawal.id, action: "settle" } },
    );
    setActionLoading(null);

    if (!response.ok) {
      toast({ title: "Reconciliation failed", description: response.message, tone: "error" });
      return;
    }

    toast({ title: "Reconciliation run", description: response.data.message, tone: "info" });
    setOpenId(null);
    setContext(null);
    void load();
  }

  return (
    <div className="space-y-4">
      {payoutNotice ? (
        <Alert variant="warning" title={`${providerLabel} is not configured — approving will not send money`}>
          <p>{payoutNotice}</p>
          <p className="mt-2 text-xs leading-relaxed">
            A withdrawal approved now sits at <strong>APPROVED</strong> with its funds held. Nothing is
            marked PROCESSING or COMPLETED, and no payout record is created, until real merchant
            credentials are configured. Rejecting still releases the hold.
          </p>
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => {
              setStatus(tab.value);
              setPage(1);
            }}
            aria-pressed={status === tab.value}
            className={
              status === tab.value
                ? "rounded-full bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground"
                : "rounded-full border border-border px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary"
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {total} request{total === 1 ? "" : "s"} · every payout requires a human decision
            </p>
            <Button variant="ghost" size="sm" onClick={() => void load()} aria-label="Refresh queue">
              <RefreshCw className="h-4 w-4" aria-hidden />
            </Button>
          </div>

          {error ? (
            <p className="rounded-xl border border-destructive/30 bg-destructive/8 p-3 text-sm">{error}</p>
          ) : null}

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Loading requests…
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="Nothing in this queue"
              description="Withdrawal requests will appear here for review as users submit them."
            />
          ) : (
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>ID</TH>
                    <TH>User</TH>
                    <TH>Phone</TH>
                    <TH>Amount</TH>
                    <TH>Status</TH>
                    <TH>Risk</TH>
                    <TH>Requested</TH>
                    <TH>Action</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <TR key={row.id}>
                      <TD>
                        <span className="font-mono text-[11px]">{row.id.slice(0, 8)}</span>
                      </TD>
                      <TD>
                        <div>
                          <p className="text-xs font-medium">{row.user?.full_name ?? "—"}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {row.accountAgeDays}d old · {row.depositCount} deposit(s)
                          </p>
                        </div>
                      </TD>
                      <TD>
                        <span className="text-xs">{row.phone}</span>
                      </TD>
                      <TD>
                        <span className="text-xs font-semibold tabular-nums">
                          {formatMoney(Number(row.amount), row.currency)}
                        </span>
                        {Number(row.fee) > 0 ? (
                          <p className="text-[11px] text-muted-foreground">
                            net {formatMoney(Number(row.net_amount), row.currency)}
                          </p>
                        ) : null}
                      </TD>
                      <TD>
                        <Badge variant={statusBadgeVariant(row.status)}>{statusLabel(row.status)}</Badge>
                      </TD>
                      <TD>
                        <span className="text-xs">
                          {row.user?.risk_status ? statusLabel(row.user.risk_status) : "—"} ·{" "}
                          {row.risk_score}
                        </span>
                      </TD>
                      <TD>
                        <span className="text-xs" title={formatDateTime(row.requested_at)}>
                          {relativeTime(row.requested_at)}
                        </span>
                      </TD>
                      <TD>
                        <Button size="sm" variant="outline" onClick={() => void openDetail(row.id)}>
                          Review
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || loading}
                onClick={() => setPage((v) => Math.max(1, v - 1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((v) => v + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* Detail dialog                                                     */}
      {/* ---------------------------------------------------------------- */}
      <Dialog open={Boolean(openId)} onOpenChange={(open) => !open && setOpenId(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Withdrawal review</DialogTitle>
            <DialogDescription>
              Verify the account history before approving. Approving initiates a real payout.
            </DialogDescription>
          </DialogHeader>

          {contextLoading || !context ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Loading account context…
            </div>
          ) : (
            <div className="space-y-5">
              {/* Current request */}
              <div className="rounded-2xl border border-border bg-background p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-2xl font-bold tabular-nums">
                      {formatMoney(Number(context.withdrawal.amount), context.withdrawal.currency)}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      To {context.withdrawal.phone} · requested{" "}
                      {formatDateTime(context.withdrawal.requested_at)}
                    </p>
                    {Number(context.withdrawal.fee) > 0 ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Fee {formatMoney(Number(context.withdrawal.fee), context.withdrawal.currency)} ·
                        net payout{" "}
                        {formatMoney(Number(context.withdrawal.net_amount), context.withdrawal.currency)}
                      </p>
                    ) : null}
                  </div>
                  <div className="text-right">
                    <Badge variant={statusBadgeVariant(context.withdrawal.status)}>
                      {statusLabel(context.withdrawal.status)}
                    </Badge>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {context.withdrawal.id}
                    </p>
                  </div>
                </div>

                {Number(context.withdrawal.amount) >= highValueThreshold ? (
                  <Alert variant="warning" className="mt-4" title="High-value withdrawal">
                    <p>
                      This exceeds the high-value threshold of{" "}
                      {formatMoney(highValueThreshold, context.withdrawal.currency)}. Your
                      administrator password will be re-verified before the payout is initiated.
                    </p>
                  </Alert>
                ) : null}
              </div>

              {/* Account context */}
              <div className="grid gap-4 sm:grid-cols-2">
                <section className="rounded-2xl border border-border p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    User
                  </h3>
                  <dl className="mt-2 space-y-1.5 text-xs">
                    <Row label="Name" value={context.profile?.full_name ?? "—"} />
                    <Row label="Email" value={context.profile?.email ?? "—"} />
                    <Row label="Phone" value={context.profile?.phone ?? "—"} />
                    <Row
                      label="Account age"
                      value={`${Math.floor(
                        (Date.now() - new Date(context.profile?.created_at ?? Date.now()).getTime()) /
                          (24 * 3600 * 1000),
                      )} days`}
                    />
                    <Row label="Status" value={statusLabel(context.profile?.status ?? "")} />
                    <Row label="KYC" value={statusLabel(context.profile?.kyc_status ?? "")} />
                    <Row
                      label="Risk"
                      value={`${statusLabel(context.profile?.risk_status ?? "")} (${
                        context.profile?.risk_score ?? 0
                      })`}
                    />
                  </dl>
                </section>

                <section className="rounded-2xl border border-border p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Wallet
                  </h3>
                  <dl className="mt-2 space-y-1.5 text-xs">
                    <Row
                      label="Available"
                      value={formatMoney(
                        Number(context.wallet?.available_balance ?? 0),
                        context.wallet?.currency ?? "KES",
                      )}
                    />
                    <Row
                      label="Locked"
                      value={formatMoney(
                        Number(context.wallet?.locked_balance ?? 0),
                        context.wallet?.currency ?? "KES",
                      )}
                    />
                    <Row label="Deposits" value={String(context.deposits.length)} />
                    <Row label="Referrals" value={String(context.referrals.length)} />
                    <Row
                      label="Open fraud signals"
                      value={String(
                        context.fraudEvents.filter((e) => e.status === "OPEN" || e.status === "REVIEWING")
                          .length,
                      )}
                    />
                  </dl>
                </section>
              </div>

              {/* Fraud signals */}
              {context.fraudEvents.length > 0 ? (
                <section>
                  <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
                    Fraud signals
                  </h3>
                  <ul className="mt-2 space-y-1.5">
                    {context.fraudEvents.slice(0, 6).map((event) => (
                      <li
                        key={event.id}
                        className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-xs"
                      >
                        <span className="truncate">{event.event_type}</span>
                        <span className="flex shrink-0 items-center gap-2">
                          <Badge
                            variant={
                              event.severity === "HIGH" || event.severity === "CRITICAL"
                                ? "destructive"
                                : event.severity === "MEDIUM"
                                  ? "warning"
                                  : "default"
                            }
                          >
                            {event.severity}
                          </Badge>
                          <span className="text-muted-foreground">{statusLabel(event.status)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {/* Previous withdrawals */}
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Previous withdrawals
                </h3>
                {context.previousWithdrawals.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">No prior withdrawals.</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {context.previousWithdrawals.slice(0, 5).map((item) => (
                      <li
                        key={item.id}
                        className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-xs"
                      >
                        <span className="tabular-nums">
                          {formatMoney(Number(item.amount), context.withdrawal.currency)}
                        </span>
                        <span className="flex items-center gap-3">
                          <span className="text-muted-foreground">
                            {formatDateTime(item.requested_at)}
                          </span>
                          <Badge variant={statusBadgeVariant(item.status)}>
                            {statusLabel(item.status)}
                          </Badge>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Ledger */}
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Recent ledger entries
                </h3>
                <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                  {context.ledger.slice(0, 10).map((tx) => (
                    <li key={tx.id} className="flex items-center justify-between gap-3 text-xs">
                      <span className="font-mono text-[11px] text-muted-foreground">{tx.reference}</span>
                      <span className="tabular-nums">
                        {formatMoney(Number(tx.amount), tx.currency)} · {statusLabel(tx.status)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              <Separator />

              {approveError ? (
                <Alert variant="destructive" title="Action failed">
                  <p>{approveError}</p>
                </Alert>
              ) : null}

              <DialogFooter>
                {context.withdrawal.status === "PROCESSING" ? (
                  <Button variant="outline" onClick={() => void settle()} loading={actionLoading === "settle"}>
                    <RefreshCw className="h-4 w-4" aria-hidden />
                    Reconcile with provider
                  </Button>
                ) : null}

                {/*
                  Jump to the underlying records rather than making the operator
                  hunt for them. The search term is the user's email (or their
                  phone, if no email is on file) and the withdrawal reference, so
                  the destination table lands already filtered.
                */}
                <Button asChild variant="ghost">
                  <Link
                    href={`/admin/users?search=${encodeURIComponent(
                      context.profile?.email ?? context.withdrawal.phone,
                    )}`}
                  >
                    <UserRound className="h-4 w-4" aria-hidden />
                    View user
                  </Link>
                </Button>

                <Button asChild variant="ghost">
                  <Link
                    href={`/admin/transactions?search=${encodeURIComponent(
                      context.profile?.email ?? context.withdrawal.phone,
                    )}`}
                  >
                    <BookOpenCheck className="h-4 w-4" aria-hidden />
                    View ledger
                  </Link>
                </Button>

                <Button
                  variant="outline"
                  className="text-destructive"
                  disabled={!["PENDING_ADMIN_APPROVAL", "APPROVED"].includes(context.withdrawal.status)}
                  onClick={() => setRejectOpen(true)}
                >
                  <Ban className="h-4 w-4" aria-hidden />
                  Reject
                </Button>

                <Button
                  disabled={context.withdrawal.status !== "PENDING_ADMIN_APPROVAL"}
                  onClick={() => setApproveOpen(true)}
                >
                  <Send className="h-4 w-4" aria-hidden />
                  Approve &amp; Send
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ---------------------------------------------------------------- */}
      {/* Approval confirmation                                            */}
      {/* ---------------------------------------------------------------- */}
      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />
              Confirm payout
            </DialogTitle>
            <DialogDescription>
              {payoutNotice
                ? `This will record your approval. No payment will be sent, because ${providerLabel} is not configured.`
                : `Are you sure you want to approve this withdrawal and initiate the ${providerLabel} disbursement?`}
            </DialogDescription>
          </DialogHeader>

          {context ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-border bg-background p-3 text-xs">
                <Row
                  label="Amount"
                  value={formatMoney(Number(context.withdrawal.amount), context.withdrawal.currency)}
                />
                <Row
                  label="Net payout"
                  value={formatMoney(Number(context.withdrawal.net_amount), context.withdrawal.currency)}
                />
                <Row label="Destination" value={context.withdrawal.phone} />
                <Row label="User" value={context.profile?.email ?? "—"} />
              </div>

              {payoutNotice ? (
                <Alert variant="warning" title={`${providerLabel} is not configured`}>
                  <p>
                    The request will be recorded as approved and the funds stay locked. No payout is
                    attempted and nothing is marked paid. {payoutNotice}
                  </p>
                </Alert>
              ) : (
                <Alert variant="info">
                  <p>
                    The withdrawal moves to <strong>payment being processed</strong> — not completed. It
                    is only marked completed once the payment provider confirms the payout.
                  </p>
                </Alert>
              )}

              {Number(context.withdrawal.amount) >= highValueThreshold ? (
                <Field
                  label="Your administrator password"
                  htmlFor="adminPassword"
                  hint="Required for high-value approvals."
                >
                  <Input
                    id="adminPassword"
                    type="password"
                    autoComplete="current-password"
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                  />
                </Field>
              ) : null}

              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="mt-0.5 h-5 w-5 rounded-md border border-input"
                />
                <span className="text-muted-foreground">
                  I have reviewed this request, the destination number and the account history.
                </span>
              </label>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setApproveOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void approve()}
              loading={actionLoading === "approve"}
              disabled={
                !acknowledged ||
                !context ||
                (Number(context.withdrawal.amount) >= highValueThreshold && adminPassword.length === 0)
              }
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              Approve &amp; initiate payout
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------------------------------------------------------- */}
      {/* Rejection                                                        */}
      {/* ---------------------------------------------------------------- */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject withdrawal</DialogTitle>
            <DialogDescription>
              The held funds will be returned to the user&apos;s available balance and the user will
              be notified with your reason.
            </DialogDescription>
          </DialogHeader>

          <Field
            label="Reason for rejection"
            htmlFor="rejectReason"
            hint="Required. This is shown to the user and recorded in the audit log."
          >
            <Textarea
              id="rejectReason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="For example: the destination number does not match the account holder."
            />
          </Field>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void reject()}
              loading={actionLoading === "reject"}
              disabled={rejectReason.trim().length < 5}
            >
              Reject and release funds
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}
