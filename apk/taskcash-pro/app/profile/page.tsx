"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  ChevronRight,
  LogOut,
  Pencil,
  RotateCcw,
  ShieldCheck,
  UserCog,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Modal } from "@/components/modal";
import { PageHeader } from "@/components/page-header";
import { PrimaryButton } from "@/components/primary-button";
import { StatusBadge } from "@/components/status-badge";
import { useToast } from "@/components/toast";
import { cn, formatDate } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function ProfilePage() {
  const { state, updateProfile, logout, resetDemo } = useStore();
  const toast = useToast();
  const router = useRouter();

  const [editing, setEditing] = React.useState(false);
  const [form, setForm] = React.useState({
    name: state.user.name,
    email: state.user.email,
    phone: state.user.phone,
  });
  const [notifications, setNotifications] = React.useState(true);
  const [resetting, setResetting] = React.useState(false);

  /* Keep the form in step when the store changes underneath it. */
  React.useEffect(() => {
    setForm({ name: state.user.name, email: state.user.email, phone: state.user.phone });
  }, [state.user.name, state.user.email, state.user.phone]);

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    updateProfile(form);
    setEditing(false);
    toast.success("Profile updated", "Your demo profile has been saved.");
  };

  const rows = [
    { label: "Edit Profile", hint: "Name, email and phone", icon: UserCog, onClick: () => setEditing(true) },
    {
      label: "Notifications",
      hint: notifications ? "Task and payout alerts on" : "All alerts muted",
      icon: Bell,
      trailing: (
        <button
          type="button"
          role="switch"
          aria-checked={notifications}
          aria-label="Toggle notifications"
          onClick={() => setNotifications((prev) => !prev)}
          className={cn(
            "relative h-6 w-11 shrink-0 rounded-full border transition",
            notifications ? "border-cash/50 bg-cash/30" : "border-hairline bg-base",
          )}
        >
          <span
            className={cn(
              "absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full transition-all",
              notifications ? "left-[22px] bg-cash" : "left-1 bg-muted",
            )}
          />
        </button>
      ),
    },
    { label: "Security", hint: "Password and sessions (mock)", icon: ShieldCheck },
  ];

  return (
    <AppShell>
      <PageHeader title="Profile" subtitle="Your demo identity and account preferences." />

      <section className="tc-card p-4 sm:p-5">
        <div className="flex items-center gap-4">
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-gradient-to-b from-brand to-brand-600 text-lg font-extrabold text-white">
            {state.user.avatarInitials}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-bold tracking-tight text-white">{state.user.name}</p>
            <p className="truncate text-[12px] text-muted">{state.user.email}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <StatusBadge tone={state.user.accountStatus === "verified" ? "active" : "pending"} dot>
                {state.user.accountStatus}
              </StatusBadge>
              <span className="text-[11px] text-muted">
                Joined {formatDate(state.user.joinedAt)}
              </span>
            </div>
          </div>
          <PrimaryButton variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            Edit
          </PrimaryButton>
        </div>

        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          {[
            { label: "Phone", value: state.user.phone },
            { label: "Account status", value: state.user.accountStatus },
            { label: "Referral code", value: state.referral.code },
          ].map((item) => (
            <div key={item.label} className="rounded-tile border border-hairline bg-base/40 px-3.5 py-2.5">
              <dt className="tc-label">{item.label}</dt>
              <dd className="tnum mt-1 truncate text-[13px] font-semibold capitalize text-white">
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="tc-card mt-4 overflow-hidden p-0">
        <ul className="divide-y divide-hairline/70">
          {rows.map((row) => {
            const Icon = row.icon;
            return (
              <li key={row.label}>
                <button
                  type="button"
                  onClick={row.onClick}
                  className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-white/[0.03]"
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-tile border border-hairline bg-raised text-brand-400">
                    <Icon className="h-[17px] w-[17px]" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-white">{row.label}</span>
                    <span className="block truncate text-[11px] text-muted">{row.hint}</span>
                  </span>
                  {row.trailing ?? <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mt-4 flex flex-col gap-2.5 sm:flex-row">
        <PrimaryButton
          variant="outline"
          size="lg"
          full
          onClick={() => setResetting(true)}
        >
          <RotateCcw className="h-4 w-4" aria-hidden />
          Reset demo data
        </PrimaryButton>
        <PrimaryButton
          variant="ghost"
          size="lg"
          full
          className="text-flame-400 hover:bg-flame/10"
          onClick={() => {
            logout();
            router.push("/login");
          }}
        >
          <LogOut className="h-4 w-4" aria-hidden />
          Logout
        </PrimaryButton>
      </section>

      <p className="mt-4 text-center text-[10px] leading-snug text-muted/80">
        TaskCash Pro demo · mock data stored in this browser · no real payments
      </p>

      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit profile"
        description="Changes are saved to the mock store only."
        footer={
          <div className="flex gap-2">
            <PrimaryButton variant="ghost" full size="lg" onClick={() => setEditing(false)}>
              Cancel
            </PrimaryButton>
            <PrimaryButton full size="lg" onClick={save}>
              Save changes
            </PrimaryButton>
          </div>
        }
      >
        <form onSubmit={save} className="space-y-3.5">
          {(
            [
              { id: "name", label: "Full name", type: "text" },
              { id: "email", label: "Email address", type: "email" },
              { id: "phone", label: "Phone number", type: "tel" },
            ] as const
          ).map((field) => (
            <div key={field.id}>
              <label htmlFor={`profile-${field.id}`} className="mb-1.5 block text-[13px] font-semibold text-white">
                {field.label}
              </label>
              <input
                id={`profile-${field.id}`}
                type={field.type}
                value={form[field.id]}
                onChange={(event) => setForm((prev) => ({ ...prev, [field.id]: event.target.value }))}
                className="h-11 w-full rounded-tile border border-hairline bg-base/70 px-3 text-sm text-white placeholder:text-muted/70 focus:border-flame/60 focus:outline-none focus:ring-2 focus:ring-flame/25"
              />
            </div>
          ))}
        </form>
      </Modal>

      <Modal
        open={resetting}
        onClose={() => setResetting(false)}
        title="Reset demo data"
        description="Clears the stored mock account and signs you out."
        footer={
          <div className="flex gap-2">
            <PrimaryButton variant="ghost" full size="lg" onClick={() => setResetting(false)}>
              Cancel
            </PrimaryButton>
            <PrimaryButton
              full
              size="lg"
              onClick={() => {
                resetDemo();
                router.push("/login");
              }}
            >
              Reset everything
            </PrimaryButton>
          </div>
        }
      >
        <p className="text-[12px] leading-relaxed text-muted">
          This deletes the wallet, packages, tasks and ledger entries held in this browser and
          restores a fresh demo account. Nothing outside your browser is affected.
        </p>
      </Modal>
    </AppShell>
  );
}
