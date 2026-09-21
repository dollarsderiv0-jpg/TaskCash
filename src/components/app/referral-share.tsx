"use client";

import * as React from "react";
import { Check, Copy, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

export function ReferralShare({ code, link }: { code: string; link: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = React.useState<"code" | "link" | null>(null);

  async function copy(value: string, kind: "code" | "link") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 2000);
      toast({ title: kind === "code" ? "Referral code copied" : "Referral link copied", tone: "success" });
    } catch {
      toast({
        title: "Could not copy automatically",
        description: "Please select and copy the text manually.",
        tone: "warning",
      });
    }
  }

  async function share() {
    const shareData = {
      title: "TaskCash Pro",
      text: `Join me on TaskCash Pro. Use my referral code ${code}.`,
      url: link,
    };

    if (typeof navigator !== "undefined" && "share" in navigator) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        // The user dismissed the share sheet — no error to report.
      }
    }

    await copy(link, "link");
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-background p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Your referral code</p>
        <div className="mt-2 flex items-center justify-between gap-3">
          <code className="font-mono text-xl font-bold tracking-wider">{code}</code>
          <Button size="sm" variant="outline" onClick={() => copy(code, "code")}>
            {copied === "code" ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            {copied === "code" ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-background p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Your referral link</p>
        <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{link}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => copy(link, "link")}>
            {copied === "link" ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            {copied === "link" ? "Copied" : "Copy link"}
          </Button>
          <Button size="sm" variant="outline" onClick={share}>
            <Share2 className="h-4 w-4" aria-hidden />
            Share
          </Button>
        </div>
      </div>
    </div>
  );
}
