import type { Metadata } from "next";
import Link from "next/link";
import { Bell } from "lucide-react";
import { guardPage } from "@/lib/auth/guards";
import { listNotifications } from "@/server/services/notifications";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, EmptyState } from "@/components/ui/misc";
import { relativeTime } from "@/lib/money/format";

export const metadata: Metadata = { title: "Notifications" };

export const dynamic = "force-dynamic";

const TONE: Record<string, "success" | "warning" | "destructive" | "info" | "default"> = {
  SUCCESS: "success",
  WARNING: "warning",
  ERROR: "destructive",
  INFO: "info",
};

export default async function NotificationsPage() {
  const session = await guardPage();
  const notifications = await listNotifications(session.profile.id, 100);
  const unread = notifications.filter((item) => !item.read_at).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {unread > 0 ? `${unread} unread update${unread === 1 ? "" : "s"}.` : "You are all caught up."}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>
            Deposit, reward, referral and withdrawal updates are recorded here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {notifications.length === 0 ? (
            <EmptyState
              icon={Bell}
              title="No notifications yet"
              description="Updates about your deposits, rewards and withdrawals will appear here."
              className="py-8"
            />
          ) : (
            <ul className="divide-y divide-border">
              {notifications.map((item) => (
                <li key={item.id} className="py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold">{item.title}</p>
                        {!item.read_at ? <Badge variant="info">New</Badge> : null}
                      </div>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                        {item.message}
                      </p>
                      <p className="mt-1.5 text-[11px] text-muted-foreground">
                        {relativeTime(item.created_at)}
                      </p>
                    </div>
                    <Badge variant={TONE[item.severity] ?? "default"}>{item.severity}</Badge>
                  </div>
                  {item.link ? (
                    <Link
                      href={item.link}
                      className="mt-2 inline-block text-xs font-medium text-primary hover:underline"
                    >
                      Open
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
