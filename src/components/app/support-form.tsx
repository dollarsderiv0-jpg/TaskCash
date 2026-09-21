"use client";

import * as React from "react";
import { MessageSquarePlus, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/fields";
import { Alert } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";
import { SUPPORT_CATEGORY_LABELS, supportStatusLabel, type SupportTicket } from "@/lib/types";

type CreateResponse = { ticket: SupportTicket; message: string };

const CATEGORY_OPTIONS: { value: keyof typeof SUPPORT_CATEGORY_LABELS; label: string }[] = [
  { value: "PAYMENT", label: "A payment problem" },
  { value: "DEPOSIT", label: "A deposit that did not arrive" },
  { value: "WITHDRAWAL", label: "A withdrawal that is taking long" },
  { value: "REWARDS", label: "A reward I did not receive" },
  { value: "REFERRALS", label: "A referral question" },
  { value: "ACCOUNT", label: "I cannot get into my account" },
  { value: "GENERAL", label: "Something else" },
  { value: "OTHER", label: "Other" },
];

/**
 * Support ticket form.
 *
 * The category drives what we ask for and how the request is routed. The ticket
 * reference is quoted back on success so the user has something concrete to
 * refer to, and the status shown is the friendly label — never the raw code.
 */
export function SupportForm({
  defaultReference = "",
  supportEmail,
}: {
  defaultReference?: string;
  supportEmail?: string | null;
}) {
  const { toast } = useToast();

  const [category, setCategory] = React.useState<string>("PAYMENT");
  const [subject, setSubject] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [reference, setReference] = React.useState(defaultReference);
  const [loading, setLoading] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<SupportTicket | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});
    setFormError(null);

    const nextErrors: Record<string, string> = {};
    if (subject.trim().length < 3) nextErrors.subject = "Give your request a short title.";
    if (message.trim().length < 10) nextErrors.message = "Tell us what happened, in a sentence or two.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setLoading(true);
    const response = await apiRequest<CreateResponse>("/api/support/tickets", {
      method: "POST",
      body: {
        category,
        subject: subject.trim(),
        message: message.trim(),
        reference: reference.trim() || undefined,
      },
    });
    setLoading(false);

    if (!response.ok) {
      setErrors(response.fields ?? {});
      setFormError(response.message);
      return;
    }

    setCreated(response.data.ticket);
    toast({
      title: "Request received",
      description: `Reference ${response.data.ticket.reference}.`,
      tone: "success",
    });
  }

  if (created) {
    return (
      <Alert variant="success" title="Your request has been sent">
        <div className="space-y-2">
          <p>
            Reference <strong className="font-mono">{created.reference}</strong> — quote this if you
            contact us again about the same issue.
          </p>
          <p>Status: {supportStatusLabel(created.status)}</p>
          <p className="text-xs">
            Our team will reply in your support requests below. You will also get a notification when
            the status changes.
          </p>
        </div>
        <Button className="mt-4" variant="outline" onClick={() => setCreated(null)}>
          Send another request
        </Button>
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      {formError ? (
        <Alert variant="destructive" title="Request not sent">
          <p>{formError}</p>
          {supportEmail ? (
            <p className="mt-2 text-xs">
              You can also email us directly at{" "}
              <a className="underline underline-offset-2" href={`mailto:${supportEmail}`}>
                {supportEmail}
              </a>
              .
            </p>
          ) : null}
        </Alert>
      ) : null}

      <Field label="What is this about?" htmlFor="category" error={errors.category}>
        <Select
          id="category"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          {CATEGORY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Title"
        htmlFor="subject"
        error={errors.subject}
        hint="A few words, e.g. “Withdrawal requested 3 days ago”."
      >
        <Input
          id="subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          maxLength={140}
          aria-invalid={Boolean(errors.subject)}
        />
      </Field>

      <Field
        label="What happened?"
        htmlFor="message"
        error={errors.message}
        hint="Include dates, amounts and anything you have already tried."
      >
        <Textarea
          id="message"
          rows={6}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          maxLength={5000}
          aria-invalid={Boolean(errors.message)}
        />
      </Field>

      <Field
        label="Reference (optional)"
        htmlFor="reference"
        error={errors.reference}
        hint="Paste the reference from Wallet → Transaction history, if you have one."
      >
        <Input
          id="reference"
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          maxLength={64}
          placeholder="e.g. WD-8F42K1"
          aria-invalid={Boolean(errors.reference)}
        />
      </Field>

      <Button type="submit" size="lg" className="w-full" loading={loading}>
        <Send className="h-4 w-4" aria-hidden />
        Send request
      </Button>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <MessageSquarePlus className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        Never send your password, PIN or one-time codes. Our team will never ask for them.
      </p>
    </form>
  );
}
