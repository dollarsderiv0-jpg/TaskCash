"use client";

import * as React from "react";
import { Gift, Plus, Copy, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/misc";
import { apiRequest } from "@/lib/client/api";
import { formatMoney } from "@/lib/money/format";

type RedeemCode = {
  id: string;
  code: string;
  amount: number;
  max_redemptions: number;
  redemptions_used: number;
  expires_at: string | null;
  status: string;
  created_at: string;
};

export default function AdminRedeemCodesPage() {
  const [codes, setCodes] = React.useState<RedeemCode[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [amount, setAmount] = React.useState("");
  const [maxRedemptions, setMaxRedemptions] = React.useState("5");
  const [expiresHours, setExpiresHours] = React.useState("48");
  const [count, setCount] = React.useState("1");
  const [error, setError] = React.useState<string | null>(null);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);

  React.useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    const res = await apiRequest<{ codes: RedeemCode[] }>("/api/admin/redeem-codes");
    if (res.ok) setCodes(res.data.codes);
    setLoading(false);
  }

  async function create() {
    setCreating(true);
    setError(null);

    const res = await apiRequest<{ codes: RedeemCode[]; count: number }>(
      "/api/admin/redeem-codes",
      {
        method: "POST",
        body: {
          amount: Number(amount),
          maxRedemptions: Number(maxRedemptions),
          expiresInHours: Number(expiresHours) || undefined,
          count: Number(count),
        },
      },
    );

    if (!res.ok) {
      setError(res.message);
      setCreating(false);
      return;
    }

    setCodes((prev) => [...(res.data.codes ?? []), ...prev]);
    setAmount("");
    setCreating(false);
  }

  function copyCode(code: string) {
    navigator.clipboard.writeText(code);
    setCopiedId(code);
    setTimeout(() => setCopiedId(null), 2000);
  }

  return (
    <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Redeem Codes</h1>
            <p className="text-sm text-muted-foreground">
              Generate codes that users can redeem for wallet credit.
            </p>
          </div>
          <Gift className="h-6 w-6 text-muted-foreground" />
        </div>

        {/* Create form */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Generate New Codes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              <div>
                <label className="text-xs font-medium">Amount (KES)</label>
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="e.g. 100"
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium">Max redemptions</label>
                <input
                  type="number"
                  value={maxRedemptions}
                  onChange={(e) => setMaxRedemptions(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium">Expires in (hours)</label>
                <input
                  type="number"
                  value={expiresHours}
                  onChange={(e) => setExpiresHours(e.target.value)}
                  placeholder="48"
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium">Batch count</label>
                <input
                  type="number"
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  min={1}
                  max={50}
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div className="flex items-end">
                <Button
                  className="w-full"
                  loading={creating}
                  onClick={create}
                  disabled={!amount || Number(amount) <= 0}
                >
                  <Plus className="h-4 w-4" />
                  Generate
                </Button>
              </div>
            </div>
            {error && (
              <p className="mt-2 text-sm text-destructive">{error}</p>
            )}
          </CardContent>
        </Card>

        {/* Codes list */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">All Codes ({codes.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : codes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No codes created yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="pb-2 pr-4">Code</th>
                      <th className="pb-2 pr-4">Amount</th>
                      <th className="pb-2 pr-4">Redeemed</th>
                      <th className="pb-2 pr-4">Status</th>
                      <th className="pb-2 pr-4">Expires</th>
                      <th className="pb-2">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {codes.map((c) => (
                      <tr key={c.id}>
                        <td className="py-2 pr-4 font-mono text-xs font-bold">{c.code}</td>
                        <td className="py-2 pr-4">{formatMoney(c.amount, "KES")}</td>
                        <td className="py-2 pr-4">
                          {c.redemptions_used}/{c.max_redemptions}
                        </td>
                        <td className="py-2 pr-4">
                          <Badge variant={c.status === "ACTIVE" ? "success" : "outline"}>
                            {c.status}
                          </Badge>
                        </td>
                        <td className="py-2 pr-4 text-xs text-muted-foreground">
                          {c.expires_at
                            ? new Date(c.expires_at).toLocaleDateString()
                            : "Never"}
                        </td>
                        <td className="py-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => copyCode(c.code)}
                          >
                            {copiedId === c.code ? (
                              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
  );
}
