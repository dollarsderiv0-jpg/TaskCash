"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/**
 * Restores the getting-started checklist.
 *
 * Dismissing it writes a key to localStorage, which is the right storage for a
 * presentation preference — but it made skipping permanent and accidental, with
 * no way back. This clears it and returns to the dashboard, where the checklist
 * reappears until its steps are genuinely complete.
 */
export function RestartOnboarding() {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);

  async function restore() {
    setBusy(true);
    try {
      window.localStorage.removeItem("taskcash.onboarding.dismissed");
    } catch {
      // Storage unavailable — the checklist reads as "not dismissed" anyway.
    }

    toast({
      title: "Getting started restored",
      description: "The checklist is back on your dashboard.",
      tone: "success",
    });

    router.push("/dashboard");
    router.refresh();
    setBusy(false);
  }

  return (
    <Button variant="outline" onClick={restore} loading={busy}>
      <RotateCcw className="h-4 w-4" aria-hidden />
      Show the getting-started checklist
    </Button>
  );
}
