"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Megaphone, Plus, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/fields";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, EmptyState, Progress, statusBadgeVariant } from "@/components/ui/misc";
import { TBody, TD, TH, THead, TR, Table, TableWrap } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";
import { formatMoney } from "@/lib/money/format";
import { statusLabel, type Video as VideoRow, type VideoCampaign } from "@/lib/types";

/**
 * Video and campaign management.
 *
 * Note the relationship this screen encodes: a campaign owns the budget, and a
 * video owns the reward. Rewards stop automatically the moment a campaign's
 * `spent` reaches its `budget`, enforced in the database — so this UI cannot
 * accidentally run a campaign past its funding.
 */
export function VideosEditor({
  videos,
  campaigns,
  currencies,
}: {
  videos: VideoRow[];
  campaigns: VideoCampaign[];
  currencies: { code: string; name: string; enabled: boolean }[];
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [videoOpen, setVideoOpen] = React.useState(false);
  const [campaignOpen, setCampaignOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [editingVideo, setEditingVideo] = React.useState<VideoRow | null>(null);
  const [editingCampaign, setEditingCampaign] = React.useState<VideoCampaign | null>(null);

  async function saveVideo(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const payload = {
      id: editingVideo?.id,
      campaignId: (form.get("campaignId") as string) || null,
      title: String(form.get("title") ?? ""),
      description: (form.get("description") as string) || null,
      videoUrl: String(form.get("videoUrl") ?? ""),
      thumbnailUrl: (form.get("thumbnailUrl") as string) || null,
      durationSeconds: Number(form.get("durationSeconds")),
      requiredWatchSeconds: Number(form.get("requiredWatchSeconds")),
      rewardAmount: Number(form.get("rewardAmount")),
      currency: String(form.get("currency") ?? "KES"),
      dailyLimit: Number(form.get("dailyLimit") ?? 1),
      totalViewLimit: form.get("totalViewLimit") ? Number(form.get("totalViewLimit")) : null,
      status: String(form.get("status") ?? "DRAFT"),
    };

    const response = await apiRequest<{ message: string }>("/api/admin/videos", {
      method: "POST",
      body: payload,
    });

    setLoading(false);

    if (!response.ok) {
      setError(response.message);
      return;
    }

    toast({ title: "Video saved", description: response.data.message, tone: "success" });
    setVideoOpen(false);
    setEditingVideo(null);
    router.refresh();
  }

  async function saveCampaign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const payload = {
      id: editingCampaign?.id,
      name: String(form.get("name") ?? ""),
      description: (form.get("description") as string) || null,
      advertiser: (form.get("advertiser") as string) || null,
      budget: Number(form.get("budget") ?? 0),
      rewardPerView: Number(form.get("rewardPerView") ?? 0),
      maxViews: form.get("maxViews") ? Number(form.get("maxViews")) : null,
      startAt: (form.get("startAt") as string) || null,
      endAt: (form.get("endAt") as string) || null,
      status: String(form.get("status") ?? "DRAFT"),
    };

    const response = await apiRequest<{ message: string }>("/api/admin/videos?kind=campaign", {
      method: "POST",
      body: payload,
    });

    setLoading(false);

    if (!response.ok) {
      setError(response.message);
      return;
    }

    toast({ title: "Campaign saved", description: response.data.message, tone: "success" });
    setCampaignOpen(false);
    setEditingCampaign(null);
    router.refresh();
  }

  const currency = videos[0]?.currency ?? "KES";

  return (
    <div className="space-y-5">
      <Alert variant="info" title="Budget is a hard ceiling">
        <p>
          A video only pays while its campaign is active, within its date window, under its view
          limit, and while <code className="font-mono text-xs">spent + reward ≤ budget</code>. When
          the budget is exhausted, rewards stop automatically.
        </p>
      </Alert>

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle>Video campaigns</CardTitle>
            <CardDescription>Funding, duration window and total budget.</CardDescription>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setEditingCampaign(null);
              setError(null);
              setCampaignOpen(true);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden />
            New campaign
          </Button>
        </CardHeader>
        <CardContent>
          {campaigns.length === 0 ? (
            <EmptyState
              icon={Megaphone}
              title="No campaigns yet"
              description="Create a campaign first, then add videos to it."
            />
          ) : (
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>Campaign</TH>
                    <TH>Status</TH>
                    <TH>Budget</TH>
                    <TH>Spent</TH>
                    <TH>Views</TH>
                    <TH>Window</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {campaigns.map((campaign) => {
                    const used = campaign.budget > 0 ? (campaign.spent / campaign.budget) * 100 : 0;
                    return (
                      <TR key={campaign.id}>
                        <TD>
                          <p className="text-xs font-medium">{campaign.name}</p>
                          {campaign.advertiser ? (
                            <p className="text-[11px] text-muted-foreground">{campaign.advertiser}</p>
                          ) : null}
                        </TD>
                        <TD>
                          <Badge variant={statusBadgeVariant(campaign.status)}>
                            {statusLabel(campaign.status)}
                          </Badge>
                        </TD>
                        <TD>
                          <span className="text-xs tabular-nums">
                            {formatMoney(Number(campaign.budget), currency)}
                          </span>
                        </TD>
                        <TD>
                          <div className="w-28">
                            <Progress value={used} label="Budget used" />
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              {formatMoney(Number(campaign.spent), currency)} ({Math.round(used)}%)
                            </p>
                          </div>
                        </TD>
                        <TD>
                          <span className="text-xs tabular-nums">
                            {campaign.total_views}
                            {campaign.max_views ? ` / ${campaign.max_views}` : ""}
                          </span>
                        </TD>
                        <TD>
                          <span className="text-[11px] text-muted-foreground">
                            {campaign.start_at ? campaign.start_at.slice(0, 10) : "—"} →{" "}
                            {campaign.end_at ? campaign.end_at.slice(0, 10) : "—"}
                          </span>
                        </TD>
                        <TD>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setEditingCampaign(campaign);
                              setError(null);
                              setCampaignOpen(true);
                            }}
                          >
                            Edit
                          </Button>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle>Videos</CardTitle>
            <CardDescription>Reward, required watch time and daily limits per video.</CardDescription>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setEditingVideo(null);
              setError(null);
              setVideoOpen(true);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden />
            New video
          </Button>
        </CardHeader>
        <CardContent>
          {videos.length === 0 ? (
            <EmptyState
              icon={Video}
              title="No videos yet"
              description="Publish a video to make it available on the Watch & Earn page."
            />
          ) : (
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>Title</TH>
                    <TH>Status</TH>
                    <TH>Reward</TH>
                    <TH>Watch req.</TH>
                    <TH>Daily limit</TH>
                    <TH>Views</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {videos.map((video) => (
                    <TR key={video.id}>
                      <TD>
                        <p className="max-w-[18rem] truncate text-xs font-medium">{video.title}</p>
                      </TD>
                      <TD>
                        <Badge variant={statusBadgeVariant(video.status)}>
                          {statusLabel(video.status)}
                        </Badge>
                      </TD>
                      <TD>
                        <span className="text-xs font-semibold tabular-nums">
                          {formatMoney(Number(video.reward_amount), video.currency)}
                        </span>
                      </TD>
                      <TD>
                        <span className="text-xs tabular-nums">
                          {video.required_watch_seconds}s / {video.duration_seconds}s
                        </span>
                      </TD>
                      <TD>
                        <span className="text-xs tabular-nums">{video.daily_limit}</span>
                      </TD>
                      <TD>
                        <span className="text-xs tabular-nums">
                          {video.total_views}
                          {video.total_view_limit ? ` / ${video.total_view_limit}` : ""}
                        </span>
                      </TD>
                      <TD>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditingVideo(video);
                            setError(null);
                            setVideoOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </CardContent>
      </Card>

      {/* Campaign dialog */}
      <Dialog open={campaignOpen} onOpenChange={setCampaignOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingCampaign ? "Edit campaign" : "New campaign"}</DialogTitle>
            <DialogDescription>
              Set the funding and the date window. No rewards are paid outside this window.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={saveCampaign} className="space-y-4">
            {error ? (
              <Alert variant="destructive" title="Could not save">
                <p>{error}</p>
              </Alert>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="name">
                <Input id="name" name="name" defaultValue={editingCampaign?.name ?? ""} required />
              </Field>
              <Field label="Advertiser" htmlFor="advertiser" hint="Internal reference only.">
                <Input id="advertiser" name="advertiser" defaultValue={editingCampaign?.advertiser ?? ""} />
              </Field>
              <Field label="Budget" htmlFor="budget" hint="Total reward funding. Hard ceiling.">
                <Input
                  id="budget"
                  name="budget"
                  type="number"
                  step="0.01"
                  min="0"
                  defaultValue={editingCampaign?.budget ?? 0}
                  required
                />
              </Field>
              <Field label="Reward per view" htmlFor="rewardPerView" hint="Reference value for new videos.">
                <Input
                  id="rewardPerView"
                  name="rewardPerView"
                  type="number"
                  step="0.01"
                  min="0"
                  defaultValue={editingCampaign?.reward_per_view ?? 0}
                />
              </Field>
              <Field label="Max views" htmlFor="maxViews" hint="Leave empty for unlimited.">
                <Input
                  id="maxViews"
                  name="maxViews"
                  type="number"
                  min="1"
                  defaultValue={editingCampaign?.max_views ?? ""}
                />
              </Field>
              <Field label="Status" htmlFor="status">
                <Select id="status" name="status" defaultValue={editingCampaign?.status ?? "DRAFT"}>
                  <option value="DRAFT">Draft</option>
                  <option value="ACTIVE">Active</option>
                  <option value="PAUSED">Paused</option>
                  <option value="EXPIRED">Expired</option>
                  <option value="COMPLETED">Completed</option>
                  <option value="SUSPENDED">Suspended</option>
                </Select>
              </Field>
              <Field label="Start" htmlFor="startAt">
                <Input
                  id="startAt"
                  name="startAt"
                  type="datetime-local"
                  defaultValue={editingCampaign?.start_at?.slice(0, 16) ?? ""}
                />
              </Field>
              <Field label="End" htmlFor="endAt">
                <Input
                  id="endAt"
                  name="endAt"
                  type="datetime-local"
                  defaultValue={editingCampaign?.end_at?.slice(0, 16) ?? ""}
                />
              </Field>
            </div>

            <Field label="Description" htmlFor="campaignDescription">
              <Textarea
                id="campaignDescription"
                name="description"
                defaultValue={editingCampaign?.description ?? ""}
              />
            </Field>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setCampaignOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={loading}>
                Save campaign
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Video dialog */}
      <Dialog open={videoOpen} onOpenChange={setVideoOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingVideo ? "Edit video" : "New video"}</DialogTitle>
            <DialogDescription>
              The reward is read from this record at payout time — the app never sends it.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={saveVideo} className="space-y-4">
            {error ? (
              <Alert variant="destructive" title="Could not save">
                <p>{error}</p>
              </Alert>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Title" htmlFor="title" className="sm:col-span-2">
                <Input id="title" name="title" defaultValue={editingVideo?.title ?? ""} required />
              </Field>
              <Field label="Video URL" htmlFor="videoUrl" className="sm:col-span-2">
                <Input
                  id="videoUrl"
                  name="videoUrl"
                  type="url"
                  defaultValue={editingVideo?.video_url ?? ""}
                  placeholder="https://…"
                  required
                />
              </Field>
              <Field label="Thumbnail URL" htmlFor="thumbnailUrl" className="sm:col-span-2">
                <Input
                  id="thumbnailUrl"
                  name="thumbnailUrl"
                  type="url"
                  defaultValue={editingVideo?.thumbnail_url ?? ""}
                />
              </Field>
              <Field label="Duration (seconds)" htmlFor="durationSeconds">
                <Input
                  id="durationSeconds"
                  name="durationSeconds"
                  type="number"
                  min="5"
                  defaultValue={editingVideo?.duration_seconds ?? 60}
                  required
                />
              </Field>
              <Field
                label="Required watch (seconds)"
                htmlFor="requiredWatchSeconds"
                hint="Cannot exceed the duration. Ten seconds is the current house default."
              >
                <Input
                  id="requiredWatchSeconds"
                  name="requiredWatchSeconds"
                  type="number"
                  min="1"
                  defaultValue={editingVideo?.required_watch_seconds ?? 10}
                  required
                />
              </Field>
              <Field label="Reward amount" htmlFor="rewardAmount">
                <Input
                  id="rewardAmount"
                  name="rewardAmount"
                  type="number"
                  step="0.01"
                  min="0"
                  defaultValue={editingVideo?.reward_amount ?? 0}
                  required
                />
              </Field>
              <Field label="Currency" htmlFor="videoCurrency">
                <Select
                  id="videoCurrency"
                  name="currency"
                  defaultValue={editingVideo?.currency ?? currencies.find((c) => c.enabled)?.code ?? "KES"}
                >
                  {currencies.map((currency) => (
                    <option key={currency.code} value={currency.code}>
                      {currency.code} — {currency.name}
                      {currency.enabled ? "" : " (disabled)"}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Daily limit per user" htmlFor="dailyLimit" hint="0 means no per-video daily cap.">
                <Input
                  id="dailyLimit"
                  name="dailyLimit"
                  type="number"
                  min="0"
                  defaultValue={editingVideo?.daily_limit ?? 1}
                />
              </Field>
              <Field label="Total view limit" htmlFor="totalViewLimit" hint="Leave empty for unlimited.">
                <Input
                  id="totalViewLimit"
                  name="totalViewLimit"
                  type="number"
                  min="1"
                  defaultValue={editingVideo?.total_view_limit ?? ""}
                />
              </Field>
              <Field label="Campaign" htmlFor="campaignId" className="sm:col-span-2">
                <Select id="campaignId" name="campaignId" defaultValue={editingVideo?.campaign_id ?? ""}>
                  <option value="">No campaign (uncapped)</option>
                  {campaigns.map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>
                      {campaign.name} — spent {campaign.spent} / {campaign.budget}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Status" htmlFor="videoStatus" className="sm:col-span-2">
                <Select id="videoStatus" name="status" defaultValue={editingVideo?.status ?? "DRAFT"}>
                  <option value="DRAFT">Draft</option>
                  <option value="ACTIVE">Active</option>
                  <option value="PAUSED">Paused</option>
                  <option value="EXPIRED">Expired</option>
                  <option value="COMPLETED">Completed</option>
                  <option value="SUSPENDED">Suspended</option>
                </Select>
              </Field>
            </div>

            <Field label="Description" htmlFor="videoDescription">
              <Textarea
                id="videoDescription"
                name="description"
                defaultValue={editingVideo?.description ?? ""}
              />
            </Field>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setVideoOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={loading}>
                Save video
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
