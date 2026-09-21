"use client";

import * as React from "react";
import { Gift, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";
import { formatMoney } from "@/lib/money/format";

export function RedeeemCodeForm({ currency }: { currency: string }) {
  const { toast } = useToast();
  const [code, setCode] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<{ amount: number; remaining: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function redeem() {
    const trimmed = code.trim();
    if (!trimmed) {
      setError("Please enter a code.");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    const response = await apiRequest<{ amount: number; remaining: number }>(
      "/api/redeem",
      { method: "POST", body: { code: trimmed } },
    );

    if (!response.ok) {
      setError(response.message);
      setLoading(false);
      return;
    }

    setResult(response.data);
    setCode("");
    setLoading(false);
    toast({
      title: `KES ${formatMoney(response.data.amount, currency)} added to your wallet!`,
      tone: "success",
    });
  }

  if (result) {
    return (
      <div className="text-center space-y-3">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
          <CheckCircle2 className="h-7 w-7 text-emerald-600" />
        </div>
        <div>
          <p className="text-lg font-bold text-emerald-700">
            +{formatMoney(result.amount, currency)}
          </p>
          <p className="text-sm text-muted-foreground">
            Added to your available balance.
          </p>
          {result.remaining > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              This code can be used {result.remaining} more time{result.remaining === 1 ? "" : "s"}.
            </p>
          )}
        </div>
        <Button
          variant="outline"
          onClick={() => setResult(null)}
          className="mt-2"
        >
          Redeem another code
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="redeem-code" className="text-sm font-medium">
          Enter your code
        </label>
        <input
          id="redeem-code"
          type="text"
          value={code}
          onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(null); }}
          placeholder="e.g. TCABC123"
          className="mt-1.5 w-full rounded-xl border border-border bg-background px-4 py-3 text-center text-lg font-mono tracking-widest uppercase focus:outline-none focus:ring-2 focus:ring-orangeBrand-500"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          disabled={loading}
          onKeyDown={(e) => { if (e.key === "Enter") redeem(); }}
        />
      </div>

      {error && (
        <p className="text-sm font-medium text-destructive" role="alert">
          {error}
        </p>
      )}

      <Button
        className="w-full"
        size="lg"
        loading={loading}
        onClick={redeem}
        disabled={!code.trim()}
      >
        <Gift className="h-4 w-4" aria-hidden />
        Redeem Code
      </Button>
    </div>
  );
}
