import { z } from "zod";
import { requireSessionUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import {
  countUnreadNotifications,
  listNotifications,
  markNotificationsRead,
} from "@/server/services/notifications";

/** GET /api/notifications — the user's notification feed and unread count. */
export async function GET() {
  return runApi(async () => {
    const session = await requireSessionUser();
    const [notifications, unread] = await Promise.all([
      listNotifications(session.profile.id, 50),
      countUnreadNotifications(session.profile.id),
    ]);

    return ok({ notifications, unread });
  });
}

const markReadSchema = z.object({ ids: z.array(z.string().uuid()).max(200).optional() });

/** POST /api/notifications — marks the caller's own notifications as read. */
export async function POST(request: Request) {
  return runApi(async () => {
    const session = await requireSessionUser();
    const input = await parseBody(request, markReadSchema);
    const updated = await markNotificationsRead(session.profile.id, input.ids);
    return ok({ updated, unread: await countUnreadNotifications(session.profile.id) });
  });
}
