"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";

/**
 * Recovers rewards for sessions where the required watch time was already
 * satisfied but the client never reported completion — for example if the app
 * was closed or the network dropped.
 *
 * This does not grant anything extra: the server re-runs the same verification
 * and a session can still only be rewarded once.
 */
export function RecoveryButton() {
  const router = useRouter();
  const { toast } = useToast();
  const [loading, setLoading] = React.useState(false);

  async function run() {
    setLoading(true);
    const response = await apiRequest<{
      processed: number;
      credited: number;
      totalCredited: number;
      message: string;
    }>("/api/rewards/process", { method: "POST" });

    setLoading(false);

    if (!response.ok) {
      toast({ title: "Could not check for pending rewards", description: response.message, tone: "error" });
      return;
    }

    toast({
      title: response.data.credited > 0 ? "Rewards credited" : "Nothing to recover",
      description: response.data.message,
      tone: response.data.credited > 0 ? "success" : "info",
    });

    router.refresh();
  }

  return (
    <Button variant="outline" size="sm" onClick={run} loading={loading}>
      <RefreshCw className="h-4 w-4" aria-hidden />
      Check for pending rewards
    </Button>
  );
}
