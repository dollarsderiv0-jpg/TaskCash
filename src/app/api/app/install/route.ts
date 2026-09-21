import { requireSessionUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { appInstallSchema } from "@/lib/validation/schemas";
import { recordAppInstall } from "@/server/services/app-installs";

/**
 * POST /api/app/install
 *
 * Records that the signed-in account has the app on a device. Called from the
 * installed app itself (a standalone launch, or the browser's `appinstalled`
 * event) and from the explicit "I have added it" button on the install page.
 *
 * The user id comes from the verified session, never from the body: a caller can
 * only ever report about themselves. The response deliberately carries no
 * balances or limits — it reports that the install was recorded, nothing more.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const session = await requireSessionUser();
    const body = await parseBody(request, appInstallSchema);

    const result = await recordAppInstall({
      userId: session.profile.id,
      // `?? "MANUAL"` restates the schema's default because parseBody's generic
      // widens it to include undefined — a body with no source is the manual path.
      source: body.source ?? "MANUAL",
      userAgent: request.headers.get("user-agent"),
    });

    return ok(result);
  });
}
