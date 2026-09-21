"use client";

import * as React from "react";
import { Download, Filter, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/fields";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, EmptyState, statusBadgeVariant } from "@/components/ui/misc";
import { TBody, TD, TH, THead, TR, Table, TableWrap } from "@/components/ui/table";
import { apiRequest } from "@/lib/client/api";
import { formatDateTime, formatMoney } from "@/lib/money/format";
import { statusLabel, TRANSACTION_TYPE_LABELS } from "@/lib/types";

/**
 * Generic, server-paginated admin table.
 *
 * Every list in the admin panel reads through this component so pagination,
 * filtering and CSV export behave identically everywhere — and so a screen
 * never attempts to load thousands of rows at once.
 */

export type DataTableVariant =
  | "users"
  | "deposits"
  | "transactions"
  | "fraud"
  | "audit"
  | "reconciliation"
  | "referrals";

/**
 * Reconciliation alert codes an operator should not have to decode.
 *
 * The labels spell out what the alert means, because the two that matter most
 * (money taken with no local record, and money taken after we told the customer
 * it failed) are exactly the ones where acting on the wrong reading loses money.
 */
const ALERT_TYPE_LABELS: Record<string, string> = {
  PAYMENT_NOT_CREDITED: "Paid, but we recorded a failure",
  CREDIT_WITHOUT_PROVIDER: "Credited without provider confirmation",
  PROVIDER_COMPLETED_MISSING_LOCAL: "Paid, but no deposit on file",
  DUPLICATE_CALLBACK: "Duplicate callback",
  REFERENCE_MISMATCH: "Reference mismatch",
  AMOUNT_MISMATCH: "Amount mismatch",
  STALE_PENDING: "Pending for too long",
};

type Row = Record<string, unknown>;

type Column = {
  key: string;
  header: string;
  render: (row: Row) => React.ReactNode;
  className?: string;
};

export function DataTable({
  variant,
  endpoint,
  exportEntity,
  statusOptions,
  title,
  description,
}: {
  variant: DataTableVariant;
  endpoint: string;
  exportEntity?: string;
  statusOptions?: { value: string; label: string }[];
  title: string;
  description?: string;
}) {
  const [page, setPage] = React.useState(1);
  const [status, setStatus] = React.useState("ALL");
  const [search, setSearch] = React.useState("");
  const [appliedSearch, setAppliedSearch] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ items: Row[]; total: number; totalPages: number }>({
    items: [],
    total: 0,
    totalPages: 1,
  });

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ page: String(page), pageSize: "25", status });
    if (appliedSearch) params.set("search", appliedSearch);

    const response = await apiRequest<{ items: Row[]; total: number; totalPages: number }>(
      `${endpoint}?${params.toString()}`,
    );

    if (response.ok) {
      setResult(response.data);
    } else {
      setError(response.message);
      setResult({ items: [], total: 0, totalPages: 1 });
    }
    setLoading(false);
  }, [endpoint, page, status, appliedSearch]);

  /*
    A `?search=` in the URL pre-fills the filter.

    This is what makes "View user" and "View ledger" from a withdrawal work: the
    link lands on the right table already filtered, rather than dropping the
    administrator on an unfiltered list to search by hand.

    Applied after mount, not during render, so the server-rendered markup and the
    first client render still agree (no hydration mismatch), and it only overrides
    an empty filter — a search the administrator has already typed is never
    clobbered.
  */
  React.useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("search") ?? "";
    if (fromUrl) {
      setSearch(fromUrl);
      setAppliedSearch(fromUrl);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const columns = COLUMNS[variant];

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground">
              {result.total} record{result.total === 1 ? "" : "s"}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {statusOptions ? (
              <div className="flex items-center gap-2">
                <Filter className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                <Select
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setPage(1);
                  }}
                  className="h-9 w-auto text-xs"
                  aria-label="Filter by status"
                >
                  <option value="ALL">All statuses</option>
                  {statusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}

            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setPage(1);
                setAppliedSearch(search);
              }}
            >
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                className="h-9 w-40 text-xs"
                aria-label="Search records"
              />
              <Button type="submit" variant="outline" size="sm">
                Search
              </Button>
            </form>

            <Button variant="ghost" size="sm" onClick={() => void load()} aria-label="Refresh">
              <RefreshCw className="h-4 w-4" aria-hidden />
            </Button>

            {exportEntity ? (
              <Button asChild variant="outline" size="sm">
                <a href={`/api/admin/export?entity=${exportEntity}`}>
                  <Download className="h-4 w-4" aria-hidden />
                  CSV
                </a>
              </Button>
            ) : null}
          </div>
        </div>

        {error ? (
          <p className="rounded-xl border border-destructive/30 bg-destructive/8 p-3 text-sm">{error}</p>
        ) : null}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading records…
          </div>
        ) : result.items.length === 0 ? (
          <EmptyState title="No records found" description="Try a different status or search term." />
        ) : (
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  {columns.map((column) => (
                    <TH key={column.key} className={column.className}>
                      {column.header}
                    </TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {result.items.map((row, index) => (
                  <TR key={String(row.id ?? index)}>
                    {columns.map((column) => (
                      <TD key={column.key} className={column.className}>
                        {column.render(row)}
                      </TD>
                    ))}
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Page {page} of {result.totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || loading}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= result.totalPages || loading}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Column definitions                                                          */
/* -------------------------------------------------------------------------- */

function user(row: Row) {
  const u = row.user as { full_name?: string; email?: string } | null;
  return (
    <div className="min-w-0">
      <p className="truncate text-xs font-medium">{u?.full_name ?? "—"}</p>
      <p className="truncate text-[11px] text-muted-foreground">{u?.email ?? ""}</p>
    </div>
  );
}

function statusCell(row: Row) {
  const value = String(row.status ?? "");
  return <Badge variant={statusBadgeVariant(value)}>{statusLabel(value)}</Badge>;
}

const COLUMNS: Record<DataTableVariant, Column[]> = {
  users: [
    {
      key: "name",
      header: "User",
      render: (row) => (
        <div>
          <p className="text-xs font-medium">{String(row.full_name ?? "")}</p>
          <p className="text-[11px] text-muted-foreground">{String(row.email ?? "")}</p>
        </div>
      ),
    },
    { key: "phone", header: "Phone", render: (row) => <span className="text-xs">{String(row.phone ?? "—")}</span> },
    {
      key: "currency",
      header: "Currency",
      render: (row) => <span className="text-xs">{String(row.currency ?? "")}</span>,
    },
    {
      key: "balance",
      header: "Available",
      render: (row) => (
        <span className="text-xs font-semibold tabular-nums">
          {formatMoney(Number(row.balance ?? 0), String(row.currency ?? "KES"))}
        </span>
      ),
    },
    {
      key: "locked",
      header: "Locked",
      render: (row) => (
        <span className="text-xs tabular-nums">
          {formatMoney(Number(row.locked ?? 0), String(row.currency ?? "KES"))}
        </span>
      ),
    },
    { key: "status", header: "Status", render: statusCell },
    {
      key: "kyc",
      header: "KYC",
      render: (row) => (
        <Badge variant={statusBadgeVariant(String(row.kyc_status ?? ""))}>
          {statusLabel(String(row.kyc_status ?? ""))}
        </Badge>
      ),
    },
    {
      key: "risk",
      header: "Risk",
      render: (row) => (
        <span className="text-xs">
          {statusLabel(String(row.risk_status ?? ""))} · {String(row.risk_score ?? 0)}
        </span>
      ),
    },
    {
      key: "created",
      header: "Joined",
      render: (row) => <span className="text-xs">{formatDateTime(String(row.created_at ?? ""))}</span>,
    },
  ],

  deposits: [
    { key: "user", header: "User", render: user },
    {
      key: "amount",
      header: "Amount",
      render: (row) => (
        <span className="text-xs font-semibold tabular-nums">
          {formatMoney(Number(row.amount ?? 0), String(row.currency ?? "KES"))}
        </span>
      ),
    },
    { key: "phone", header: "Phone", render: (row) => <span className="text-xs">{String(row.phone ?? "")}</span> },
    { key: "status", header: "Status", render: statusCell },
    {
      key: "reference",
      header: "Reference",
      render: (row) => (
        <span className="font-mono text-[11px]">{String(row.merchant_reference ?? "")}</span>
      ),
    },
    {
      key: "provider",
      header: "Provider txn",
      render: (row) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {String(row.provider_transaction_id ?? "—")}
        </span>
      ),
    },
    {
      key: "created",
      header: "Created",
      render: (row) => <span className="text-xs">{formatDateTime(String(row.created_at ?? ""))}</span>,
    },
    {
      key: "failure",
      header: "Failure",
      render: (row) => (
        <span className="max-w-[16rem] truncate text-[11px] text-muted-foreground">
          {String(row.failure_reason ?? "")}
        </span>
      ),
    },
  ],

  transactions: [
    { key: "user", header: "User", render: user },
    {
      key: "type",
      header: "Type",
      render: (row) => (
        <span className="text-xs">
          {TRANSACTION_TYPE_LABELS[
            String(row.type ?? "") as keyof typeof TRANSACTION_TYPE_LABELS
          ] ?? String(row.type ?? "")}
        </span>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      render: (row) => (
        <span
          className={
            Number(row.available_delta ?? 0) > 0
              ? "text-xs font-semibold tabular-nums tc-amount-in"
              : "text-xs font-semibold tabular-nums tc-amount-out"
          }
        >
          {formatMoney(Number(row.amount ?? 0), String(row.currency ?? "KES"))}
        </span>
      ),
    },
    { key: "status", header: "Status", render: statusCell },
    {
      key: "reference",
      header: "Reference",
      render: (row) => <span className="font-mono text-[11px]">{String(row.reference ?? "")}</span>,
    },
    {
      key: "balance",
      header: "Balance after",
      render: (row) => (
        <span className="text-xs tabular-nums">
          {formatMoney(Number(row.balance_after ?? 0), String(row.currency ?? "KES"))}
        </span>
      ),
    },
    {
      key: "created",
      header: "Created",
      render: (row) => <span className="text-xs">{formatDateTime(String(row.created_at ?? ""))}</span>,
    },
  ],

  fraud: [
    { key: "user", header: "User", render: user },
    {
      key: "event",
      header: "Signal",
      render: (row) => <span className="text-xs">{String(row.event_type ?? "")}</span>,
    },
    {
      key: "severity",
      header: "Severity",
      render: (row) => {
        const severity = String(row.severity ?? "");
        return (
          <Badge
            variant={
              severity === "CRITICAL"
                ? "destructive"
                : severity === "HIGH"
                  ? "destructive"
                  : severity === "MEDIUM"
                    ? "warning"
                    : "default"
            }
          >
            {severity}
          </Badge>
        );
      },
    },
    {
      key: "score",
      header: "Score",
      render: (row) => <span className="text-xs tabular-nums">{String(row.score ?? 0)}</span>,
    },
    { key: "status", header: "Review", render: statusCell },
    {
      key: "created",
      header: "Detected",
      render: (row) => <span className="text-xs">{formatDateTime(String(row.created_at ?? ""))}</span>,
    },
  ],

  audit: [
    {
      key: "action",
      header: "Action",
      render: (row) => <span className="font-mono text-[11px]">{String(row.action ?? "")}</span>,
    },
    {
      key: "entity",
      header: "Entity",
      render: (row) => (
        <span className="text-xs">
          {String(row.entity_type ?? "")}
          {row.entity_id ? ` · ${String(row.entity_id).slice(0, 8)}` : ""}
        </span>
      ),
    },
    {
      key: "description",
      header: "Description",
      render: (row) => (
        <span className="block max-w-[24rem] truncate text-xs text-muted-foreground">
          {String(row.description ?? "")}
        </span>
      ),
    },
    {
      key: "created",
      header: "When",
      render: (row) => <span className="text-xs">{formatDateTime(String(row.created_at ?? ""))}</span>,
    },
  ],

  referrals: [
    { key: "user", header: "Referrer", render: user },
    {
      key: "amount",
      header: "Commission",
      render: (row) => (
        <span className="text-xs font-semibold tabular-nums tc-amount-in">
          {formatMoney(Number(row.amount ?? 0), String(row.currency ?? "KES"))}
        </span>
      ),
    },
    {
      key: "level",
      header: "Level",
      render: (row) => <span className="text-xs">{String(row.level ?? 1)}</span>,
    },
    {
      key: "rate",
      header: "Rate",
      render: (row) => (
        <span className="text-xs">{(Number(row.rate ?? 0) * 100).toFixed(1)}%</span>
      ),
    },
    {
      key: "event",
      header: "Qualifying event",
      render: (row) => (
        <span className="text-xs">{statusLabel(String(row.qualifying_event ?? ""))}</span>
      ),
    },
    { key: "status", header: "Status", render: statusCell },
    {
      key: "created",
      header: "Created",
      render: (row) => <span className="text-xs">{formatDateTime(String(row.created_at ?? ""))}</span>,
    },
  ],

  reconciliation: [
    {
      key: "type",
      header: "Alert",
      render: (row) => {
        const code = String(row.alert_type ?? "");
        return (
          <span className="text-xs" title={code}>
            {ALERT_TYPE_LABELS[code] ?? code}
          </span>
        );
      },
    },
    {
      key: "severity",
      header: "Severity",
      render: (row) => (
        <Badge
          variant={
            String(row.severity) === "CRITICAL" || String(row.severity) === "HIGH"
              ? "destructive"
              : String(row.severity) === "MEDIUM"
                ? "warning"
                : "default"
          }
        >
          {String(row.severity ?? "")}
        </Badge>
      ),
    },
    {
      key: "entity",
      header: "Record",
      render: (row) => {
        const entityId = String(row.entity_id ?? "");
        /*
          A provider-only finding has no local record — that is the whole point of
          it — so the id is blank and the reference is what an operator searches
          on. Showing a truncated empty id would look like a missing field.
        */
        return entityId ? (
          <span className="text-xs">
            {String(row.entity_type ?? "")} · {entityId.slice(0, 8)}
          </span>
        ) : (
          <span className="font-mono text-[11px]">{String(row.reference ?? "—")}</span>
        );
      },
    },
    {
      key: "reference",
      header: "Reference",
      render: (row) => (
        <span className="font-mono text-[11px]">{String(row.reference ?? "—")}</span>
      ),
    },
    { key: "status", header: "Status", render: statusCell },
    {
      key: "created",
      header: "Raised",
      render: (row) => <span className="text-xs">{formatDateTime(String(row.created_at ?? ""))}</span>,
    },
  ],
};
