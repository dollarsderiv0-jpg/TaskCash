"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";

/**
 * The explicit "I have added it to my home screen" confirmation.
 *
 * Needed because neither automatic signal fires for someone who installed the app
 * on an earlier visit: `appinstalled` has long since passed, and the standalone
 * check only helps while they are *inside* the app. Without this, an install made
 * before this feature existed could never be recorded at all.
 *
 * It is the user's own account being marked, from their own verified session, and
 * the button says exactly what it does. Nothing about balances or limits comes
 * back from the request.
 */
export function AppInstallButton({ installed }: { installed: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [loading, setLoading] = React.useState(false);
  const [done, setDone] = React.useState(installed);

  async function confirm() {
    setLoading(true);
    const response = await apiRequest<{ recorded: boolean; firstAt: string | null }>(
      "/api/app/install",
      { method: "POST", body: { source: "MANUAL" } },
    );
    setLoading(false);

    /*
      `recorded` is checked as well as `ok`. The request can succeed and still
      store nothing — that is what happens on a database where migration 0018 has
      not been applied — and telling the user "recorded" in that state would be a
      claim the server just contradicted.
    */
    if (!response.ok) {
      toast({ title: "Could not save that", description: response.message, tone: "error" });
      return;
    }
    if (!response.data.recorded) {
      toast({
        title: "Not saved yet",
        description:
          "Your account could not be updated just now. Please try again in a moment.",
        tone: "error",
      });
      return;
    }

    setDone(true);
    router.refresh();
    toast({ title: "App recorded", description: "Your device is now linked to your account.", tone: "success" });
  }

  if (done) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-emerald-500">
        <CheckCircle2 className="h-4 w-4" aria-hidden />
        The app is set up for this account.
      </p>
    );
  }

  return (
    <Button type="button" onClick={confirm} disabled={loading} className="w-full sm:w-auto">
      <Smartphone className="h-4 w-4" aria-hidden />
      {loading ? "Saving…" : "I have added it to my home screen"}
    </Button>
  );
}
