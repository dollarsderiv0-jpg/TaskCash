"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/fields";
import { Alert } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";

/**
 * Only the display name and mobile money number are editable.
 *
 * Email, currency, role, account status and verification status are not
 * writable from here: there is no UPDATE policy on `profiles` in the database,
 * so those fields cannot be changed by a client at all.
 */
export function ProfileForm({
  fullName,
  phone,
  country,
}: {
  fullName: string;
  phone: string;
  country: string;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [name, setName] = React.useState(fullName);
  const [phoneNumber, setPhoneNumber] = React.useState(phone);
  const [loading, setLoading] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});
    setFormError(null);

    const nextErrors: Record<string, string> = {};
    if (name.trim().length < 2) nextErrors.fullName = "Enter your full name.";
    if (phoneNumber.trim().length < 7) nextErrors.phone = "Enter your mobile money number.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setLoading(true);
    const response = await apiRequest<{ message: string }>("/api/user/me", {
      method: "PATCH",
      body: { fullName: name.trim(), phone: phoneNumber.trim() },
    });
    setLoading(false);

    if (!response.ok) {
      setErrors(response.fields ?? {});
      setFormError(response.message);
      return;
    }

    toast({ title: "Details updated", description: response.data.message, tone: "success" });
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {formError ? (
        <Alert variant="destructive" title="Could not save">
          <p>{formError}</p>
        </Alert>
      ) : null}

      <Field label="Full name" htmlFor="fullName" error={errors.fullName}>
        <Input
          id="fullName"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          aria-invalid={Boolean(errors.fullName)}
        />
      </Field>

      <Field
        label="Mobile money number"
        htmlFor="phone"
        error={errors.phone}
        hint={`Used for deposits and payouts. Stored in international format for ${country}.`}
      >
        <Input
          id="phone"
          type="tel"
          value={phoneNumber}
          onChange={(e) => setPhoneNumber(e.target.value)}
          autoComplete="tel"
          aria-invalid={Boolean(errors.phone)}
        />
      </Field>

      <Button type="submit" loading={loading}>
        Save changes
      </Button>
    </form>
  );
}
