"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/fields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, EmptyState, Separator, statusBadgeVariant } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";
import { formatDateTime } from "@/lib/money/format";
import { supportCategoryLabel, supportStatusLabel, type SupportMessage, type SupportTicket } from "@/lib/types";

type QueueRow = SupportTicket & {
  userLabel: string;
  userEmail: string | null;
  messageCount: number;
  lastMessage: string | null;
};

type QueueResponse = {
  configured: boolean;
  tickets: QueueRow[];
  counts: Record<string, number>;
};

const TABS: { key: string; label: string; help: string }[] = [
  { key: "OPEN", label: "Received", help: "Nobody has picked these up yet." },
  { key: "IN_REVIEW", label: "Being looked at", help: "Someone is working on these." },
  { key: "RESOLVED", label: "Answered", help: "Answered, but the user can reopen by replying." },
  { key: "CLOSED", label: "Closed", help: "Final. A reply from the user no longer reopens these." },
  { key: "ALL", label: "All", help: "Every request." },
];

/**
 * Support queue.
 *
 * Plain words throughout: an administrator should not have to translate a status
 * code to know whether a person is still waiting. The three actions map to the
 * only transitions that make sense — pick it up, answer it, close it — and each
 * one is a real database write with an audit record, not a local state change.
 */
export function SupportQueue() {
  const router = useRouter();
  const { toast } = useToast();

  const [tab, setTab] = React.useState("OPEN");
  const [data, setData] = React.useState<QueueResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [selected, setSelected] = React.useState<QueueRow | null>(null);
  const [thread, setThread] = React.useState<SupportMessage[] | null>(null);
  const [reply, setReply] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(
    async (which: string) => {
      setLoading(true);
      setError(null);
      const response = await apiRequest<QueueResponse>(`/api/admin/support?status=${which}`);
      setLoading(false);

      if (!response.ok) {
        setError(response.message);
        return;
      }
      setData(response.data);
    },
    [],
  );

  React.useEffect(() => {
    void load(tab);
  }, [tab, load]);

  async function openTicket(row: QueueRow) {
    setSelected(row);
    setThread(null);
    setReply("");

    const response = await apiRequest<{ ticket: SupportTicket; messages: SupportMessage[] }>(
      `/api/admin/support/${row.id}`,
    );

    if (!response.ok) {
      toast({ title: "Could not open the request", description: response.message, tone: "error" });
      return;
    }
    setThread(response.data.messages);
    setSelected({ ...row, ...response.data.ticket });
  }

  async function act(action: { status?: string; withReply?: boolean }) {
    if (!selected) return;
    const key = action.status ?? "reply";
    setBusy(key);

    const response = await apiRequest<{ ticket: SupportTicket; message: string }>(
      `/api/admin/support/${selected.id}`,
      {
        method: "POST",
        body: {
          message: action.withReply && reply.trim() ? reply.trim() : undefined,
          status: action.status,
        },
      },
    );

    setBusy(null);

    if (!response.ok) {
      toast({ title: "Could not save", description: response.message, tone: "error" });
      return;
    }

    toast({ title: "Saved", description: response.data.message, tone: "success" });
    setReply("");
    setSelected({ ...selected, status: response.data.ticket.status });

    await openTicket({ ...selected, status: response.data.ticket.status });
    await load(tab);
    router.refresh();
  }

  if (data && !data.configured) {
    return (
      <Alert variant="warning" title="Support requests are not available yet">
        <p>
          The support ticket tables have not been applied to this database. Apply migration
          <code className="mx-1">0006_support_tickets.sql</code> and reload this page.
        </p>
      </Alert>
    );
  }

  const counts = data?.counts ?? {};
  const tickets = data?.tickets ?? [];
  const activeTab = TABS.find((entry) => entry.key === tab) ?? TABS[0];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((entry) => {
          const active = entry.key === tab;
          const count = entry.key === "ALL" ? undefined : counts[entry.key];
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => setTab(entry.key)}
              aria-current={active ? "true" : undefined}
              className={
                active
                  ? "inline-flex min-h-9 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground"
                  : "inline-flex min-h-9 items-center gap-2 rounded-full border border-border px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
              }
            >
              {entry.label}
              {typeof count === "number" ? (
                <span className="rounded-full bg-black/10 px-1.5 text-xs tabular-nums dark:bg-white/15">
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load(tab)}
          loading={loading}
          className="ml-auto"
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          Refresh
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">{activeTab.help}</p>

      {error ? (
        <Alert variant="destructive" title="Could not load the queue">
          <p>{error}</p>
        </Alert>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{activeTab.label}</CardTitle>
            <CardDescription>
              {loading && !data
                ? "Checking requests…"
                : `${tickets.length} request${tickets.length === 1 ? "" : "s"}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {tickets.length === 0 && !loading ? (
              <EmptyState
                title="Nothing here"
                description="Requests appear here as soon as users send them."
                className="py-8"
              />
            ) : (
              <ul className="divide-y divide-border">
                {tickets.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => void openTicket(row)}
                      className={
                        selected?.id === row.id
                          ? "flex w-full flex-col gap-1 rounded-lg bg-primary/8 p-3 text-left"
                          : "flex w-full flex-col gap-1 rounded-lg p-3 text-left transition-colors hover:bg-secondary/50"
                      }
                    >
                      <span className="flex items-start justify-between gap-3">
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold">{row.subject}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {row.userLabel} · {supportCategoryLabel(row.category)}
                          </span>
                        </span>
                        <Badge variant={statusBadgeVariant(row.status)}>
                          {supportStatusLabel(row.status)}
                        </Badge>
                      </span>
                      <span className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                        {row.lastMessage ?? "No messages"}
                      </span>
                      <span className="mt-1 font-mono text-[11px] text-muted-foreground">
                        {row.reference} · {formatDateTime(row.last_activity_at)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{selected ? selected.subject : "Pick a request"}</CardTitle>
            <CardDescription>
              {selected
                ? `${selected.reference} · ${selected.userLabel}${
                    selected.userEmail ? ` · ${selected.userEmail}` : ""
                  }`
                : "Open a request on the left to read it and reply."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!selected ? (
              <EmptyState
                title="No request selected"
                description="The full conversation and the reply box appear here."
                className="py-8"
              />
            ) : (
              <>
                <div className="space-y-3">
                  {thread === null ? (
                    <p className="text-sm text-muted-foreground">Loading the conversation…</p>
                  ) : (
                    thread.map((message) => (
                      <div
                        key={message.id}
                        className={
                          message.author_role === "ADMIN"
                            ? "rounded-xl border border-primary/25 bg-primary/5 p-3"
                            : "rounded-xl border border-border bg-muted/20 p-3"
                        }
                      >
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {message.author_role === "ADMIN" ? "TaskCash Pro" : "User"} ·{" "}
                          {formatDateTime(message.created_at)}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-sm">{message.body}</p>
                      </div>
                    ))
                  )}
                </div>

                <Separator />

                <div className="space-y-2">
                  <label htmlFor="reply" className="text-sm font-medium">
                    Reply to the user
                  </label>
                  <Textarea
                    id="reply"
                    rows={4}
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                    placeholder="Explain what happens next, in plain language."
                  />
                  <p className="text-xs text-muted-foreground">
                    Sending a reply notifies the user and is recorded in the audit log.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => void act({ withReply: true })}
                    loading={busy === "reply"}
                    disabled={reply.trim().length === 0}
                  >
                    <Send className="h-4 w-4" aria-hidden />
                    Send reply
                  </Button>

                  {selected.status === "OPEN" ? (
                    <Button
                      variant="outline"
                      onClick={() => void act({ status: "IN_REVIEW" })}
                      loading={busy === "IN_REVIEW"}
                    >
                      Start review
                    </Button>
                  ) : null}

                  {selected.status !== "RESOLVED" && selected.status !== "CLOSED" ? (
                    <Button
                      variant="outline"
                      onClick={() => void act({ status: "RESOLVED" })}
                      loading={busy === "RESOLVED"}
                    >
                      Mark answered
                    </Button>
                  ) : null}

                  {selected.status !== "CLOSED" ? (
                    <Button
                      variant="outline"
                      onClick={() => void act({ status: "CLOSED" })}
                      loading={busy === "CLOSED"}
                    >
                      Close
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      onClick={() => void act({ status: "OPEN" })}
                      loading={busy === "OPEN"}
                    >
                      Reopen
                    </Button>
                  )}
                </div>

                <p className="text-xs text-muted-foreground">
                  A reply from the user reopens an answered request — they would not write again if
                  they were satisfied. Only closing is final.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
