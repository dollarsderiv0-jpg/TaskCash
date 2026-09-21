"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/fields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";

/**
 * Fraud review actions.
 *
 * Two separate, deliberately distinct operations:
 *  1. Closing a signal (cleared / confirmed) — a record-keeping decision.
 *  2. Changing an account's risk status — an explicit, audited enforcement
 *     action that requires a written reason.
 */
export function FraudReviewPanel() {
  const router = useRouter();
  const { toast } = useToast();

  const [mode, setMode] = React.useState<"signal" | "account">("signal");
  const [loading, setLoading] = React.useState(false);

  const [eventId, setEventId] = React.useState("");
  const [reviewStatus, setReviewStatus] = React.useState("CLEARED");
  const [riskStatus, setRiskStatus] = React.useState("NORMAL");
  const [note, setNote] = React.useState("");

  const [userId, setUserId] = React.useState("");
  const [accountStatus, setAccountStatus] = React.useState("ACTIVE");
  const [reason, setReason] = React.useState("");

  const [kycUserId, setKycUserId] = React.useState("");
  const [kycStatus, setKycStatus] = React.useState("VERIFIED");

  async function submitSignal(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);

    const response = await apiRequest<{ message: string }>("/api/admin/fraud", {
      method: "PATCH",
      body: {
        eventId,
        status: reviewStatus,
        note: note || undefined,
        riskStatus,
      },
    });

    setLoading(false);

    if (!response.ok) {
      toast({ title: "Could not update", description: response.message, tone: "error" });
      return;
    }

    toast({ title: "Review recorded", description: response.data.message, tone: "success" });
    setEventId("");
    setNote("");
    router.refresh();
  }

  async function submitAccount(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);

    const response = await apiRequest<{ message: string }>("/api/admin/users", {
      method: "PATCH",
      body: { action: "status", userId, status: accountStatus, reason },
    });

    setLoading(false);

    if (!response.ok) {
      toast({ title: "Could not update account", description: response.message, tone: "error" });
      return;
    }

    toast({ title: "Account updated", description: response.data.message, tone: "success" });
    setReason("");
    router.refresh();
  }

  async function submitKyc(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);

    const response = await apiRequest<{ message: string }>("/api/admin/users", {
      method: "PATCH",
      body: { action: "kyc", userId: kycUserId, kycStatus },
    });

    setLoading(false);

    if (!response.ok) {
      toast({ title: "Could not update verification", description: response.message, tone: "error" });
      return;
    }

    toast({ title: "Verification updated", description: response.data.message, tone: "success" });
    setKycUserId("");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review actions</CardTitle>
        <CardDescription>All three actions are written to the audit log.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap gap-2">
          {(
            [
              { key: "signal", label: "Review a signal" },
              { key: "account", label: "Change account status" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setMode(tab.key)}
              aria-pressed={mode === tab.key}
              className={
                mode === tab.key
                  ? "rounded-full bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground"
                  : "rounded-full border border-border px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary"
              }
            >
              {tab.label}
            </button>
          ))}
        </div>

        {mode === "signal" ? (
          <form onSubmit={submitSignal} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Fraud event ID" htmlFor="eventId" hint="Copy the ID from the table above.">
                <Input
                  id="eventId"
                  value={eventId}
                  onChange={(e) => setEventId(e.target.value)}
                  placeholder="uuid"
                  required
                />
              </Field>
              <Field label="Review outcome" htmlFor="reviewStatus">
                <Select
                  id="reviewStatus"
                  value={reviewStatus}
                  onChange={(e) => setReviewStatus(e.target.value)}
                >
                  <option value="REVIEWING">Reviewing</option>
                  <option value="CLEARED">Cleared — no action needed</option>
                  <option value="CONFIRMED">Confirmed — action taken</option>
                  <option value="OPEN">Reopen</option>
                </Select>
              </Field>
              <Field label="Set risk status" htmlFor="riskStatus" hint="Explicit and audited.">
                <Select id="riskStatus" value={riskStatus} onChange={(e) => setRiskStatus(e.target.value)}>
                  <option value="NORMAL">Normal</option>
                  <option value="REVIEW">Review</option>
                  <option value="RESTRICTED">Restricted (blocks withdrawals)</option>
                  <option value="SUSPENDED">Suspended (blocks earning)</option>
                </Select>
              </Field>
            </div>

            <Field label="Review note" htmlFor="note">
              <Textarea
                id="note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why was this signal cleared or confirmed?"
              />
            </Field>

            <Button type="submit" loading={loading} disabled={!eventId}>
              Record review
            </Button>
          </form>
        ) : (
          <div className="space-y-6">
            <form onSubmit={submitAccount} className="space-y-4">
              <Alert variant="warning" title="Account status changes take effect immediately">
                <p>
                  A restricted or suspended account cannot earn or withdraw. Use this only after a
                  review, and always give a reason.
                </p>
              </Alert>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="User ID" htmlFor="userId" hint="The profile UUID from the user table.">
                  <Input
                    id="userId"
                    value={userId}
                    onChange={(e) => setUserId(e.target.value)}
                    placeholder="uuid"
                    required
                  />
                </Field>
                <Field label="New status" htmlFor="accountStatus">
                  <Select
                    id="accountStatus"
                    value={accountStatus}
                    onChange={(e) => setAccountStatus(e.target.value)}
                  >
                    <option value="ACTIVE">Active</option>
                    <option value="RESTRICTED">Restricted</option>
                    <option value="SUSPENDED">Suspended</option>
                    <option value="CLOSED">Closed</option>
                  </Select>
                </Field>
              </div>

              <Field label="Reason" htmlFor="reason" hint="Recorded in the audit log and sent to the user.">
                <Textarea
                  id="reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Describe the activity that led to this decision."
                />
              </Field>

              <Button type="submit" loading={loading} disabled={!userId || reason.trim().length < 5}>
                Update account status
              </Button>
            </form>

            <form onSubmit={submitKyc} className="space-y-4 border-t border-border pt-5">
              <h3 className="text-sm font-semibold">Verification status</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="User ID" htmlFor="kycUserId">
                  <Input
                    id="kycUserId"
                    value={kycUserId}
                    onChange={(e) => setKycUserId(e.target.value)}
                    placeholder="uuid"
                    required
                  />
                </Field>
                <Field label="Verification status" htmlFor="kycStatus">
                  <Select id="kycStatus" value={kycStatus} onChange={(e) => setKycStatus(e.target.value)}>
                    <option value="NOT_STARTED">Not started</option>
                    <option value="PENDING">Pending</option>
                    <option value="VERIFIED">Verified</option>
                    <option value="REJECTED">Rejected</option>
                    <option value="REQUIRES_REVIEW">Requires review</option>
                  </Select>
                </Field>
              </div>
              <Button type="submit" variant="outline" loading={loading} disabled={!kycUserId}>
                Update verification
              </Button>
              <p className="text-xs text-muted-foreground">
                Only collect identity information the platform actually needs for its legal and
                compliance obligations.
              </p>
            </form>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
