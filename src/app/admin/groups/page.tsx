"use client";

import * as React from "react";
import { Users, Plus, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/misc";
import { apiRequest } from "@/lib/client/api";

type WhatsAppGroup = {
  id: string;
  name: string;
  invite_link: string;
  sort_order: number;
  user_start: number;
  user_end: number;
  is_active: boolean;
  created_at: string;
};

export default function AdminGroupsPage() {
  const [groups, setGroups] = React.useState<WhatsAppGroup[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState("");
  const [inviteLink, setInviteLink] = React.useState("");
  const [userStart, setUserStart] = React.useState("0");
  const [userEnd, setUserEnd] = React.useState("1000");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    const res = await apiRequest<{ groups: WhatsAppGroup[] }>("/api/admin/groups");
    if (res.ok) setGroups(res.data.groups);
    setLoading(false);
  }

  async function create() {
    setCreating(true);
    setError(null);

    const res = await apiRequest<{ group: WhatsAppGroup }>(
      "/api/admin/groups",
      {
        method: "POST",
        body: {
          name,
          inviteLink,
          sortOrder: groups.length,
          userStart: Number(userStart),
          userEnd: Number(userEnd),
        },
      },
    );

    if (!res.ok) {
      setError(res.message);
      setCreating(false);
      return;
    }

    setGroups((prev) => [...prev, res.data.group]);
    setName("");
    setInviteLink("");
    setCreating(false);
  }

  return (
    <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">WhatsApp Groups</h1>
            <p className="text-sm text-muted-foreground">
              Manage community groups. Users are auto-assigned based on sign-up order.
            </p>
          </div>
          <Users className="h-6 w-6 text-muted-foreground" />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add New Group</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-5">
              <div>
                <label className="text-xs font-medium">Group Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. TaskCash Kenya 1"
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-xs font-medium">WhatsApp Invite Link</label>
                <input
                  type="url"
                  value={inviteLink}
                  onChange={(e) => setInviteLink(e.target.value)}
                  placeholder="https://chat.whatsapp.com/..."
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium">Member range</label>
                <div className="mt-1 flex items-center gap-1">
                  <input
                    type="number"
                    value={userStart}
                    onChange={(e) => setUserStart(e.target.value)}
                    className="w-full rounded-lg border border-border bg-background px-2 py-2 text-sm"
                  />
                  <span className="text-muted-foreground">–</span>
                  <input
                    type="number"
                    value={userEnd}
                    onChange={(e) => setUserEnd(e.target.value)}
                    className="w-full rounded-lg border border-border bg-background px-2 py-2 text-sm"
                  />
                </div>
              </div>
              <div className="flex items-end">
                <Button
                  className="w-full"
                  loading={creating}
                  onClick={create}
                  disabled={!name || !inviteLink}
                >
                  <Plus className="h-4 w-4" />
                  Add
                </Button>
              </div>
            </div>
            {error && (
              <p className="mt-2 text-sm text-destructive">{error}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">All Groups ({groups.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">No groups created yet.</p>
            ) : (
              <div className="space-y-2">
                {groups.map((g) => (
                  <div
                    key={g.id}
                    className="flex items-center justify-between rounded-xl border border-border px-4 py-3"
                  >
                    <div>
                      <p className="font-medium">{g.name}</p>
                      <p className="text-xs text-muted-foreground">
                        Members {g.user_start + 1}–{g.user_end}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={g.is_active ? "success" : "outline"}>
                        {g.is_active ? "Active" : "Inactive"}
                      </Badge>
                      <a
                        href={g.invite_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-lg border border-border p-1.5 hover:bg-muted"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
  );
}
