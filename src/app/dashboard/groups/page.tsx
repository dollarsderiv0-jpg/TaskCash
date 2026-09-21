import type { Metadata } from "next";
import { requireSessionUser } from "@/lib/auth/guards";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { Users, ExternalLink } from "lucide-react";

export const metadata: Metadata = { title: "WhatsApp Groups" };

async function getMyGroup(_userId: string) {
  const admin = createAdminSupabaseClient();
  const { data } = await admin.rpc("my_whatsapp_group");
  return data as { id: string; name: string; invite_link: string; user_range: string } | null;
}

async function getAllGroups() {
  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("whatsapp_groups")
    .select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  return (data ?? []) as { id: string; name: string; invite_link: string; user_start: number; user_end: number }[];
}

export default async function GroupsPage() {
  const session = await requireSessionUser();
  const [myGroup, allGroups] = await Promise.all([
    getMyGroup(session.profile.id),
    getAllGroups(),
  ]);

  return (
    <div className="mx-auto max-w-lg space-y-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Community Groups</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Join your assigned WhatsApp group to connect with other TaskCash members.
        </p>
      </div>

      {myGroup ? (
        <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100">
              <Users className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <p className="text-xs text-emerald-600">Your group</p>
              <p className="font-bold text-emerald-800">{myGroup.name}</p>
            </div>
          </div>
          <a
            href={myGroup.invite_link}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 flex items-center justify-center gap-2 w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-700 transition"
          >
            Join on WhatsApp
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      ) : (
        <div className="rounded-2xl border border-border bg-card p-5 text-center text-sm text-muted-foreground">
          No group assigned yet. Groups are assigned as members join — check back soon.
        </div>
      )}

      {allGroups.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold">All Groups</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Members are automatically assigned based on sign-up order.
          </p>
          <div className="mt-3 space-y-2">
            {allGroups.map((g) => (
              <div
                key={g.id}
                className="flex items-center justify-between rounded-xl border border-border px-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium">{g.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Members {g.user_start + 1}–{g.user_end}
                  </p>
                </div>
                <a
                  href={g.invite_link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-orangeBrand-500 hover:underline"
                >
                  Join
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
