import { requireSessionUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { updateProfileSchema } from "@/lib/validation/schemas";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requestContext } from "@/lib/api/context";
import { normalisePhone } from "@/lib/countries";
import { getPublicSettings } from "@/lib/settings";
import { countUnreadNotifications } from "@/server/services/notifications";
import { ApiError } from "@/lib/api/errors";

export async function GET() {
  return runApi(async () => {
    const session = await requireSessionUser();
    const [settings, unread] = await Promise.all([
      getPublicSettings(),
      countUnreadNotifications(session.profile.id),
    ]);

    return ok({
      profile: session.profile,
      wallet: session.wallet,
      emailConfirmed: session.emailConfirmed,
      unreadNotifications: unread,
      settings: {
        minDeposit: settings.minDeposit,
        maxDeposit: settings.maxDeposit,
        minWithdrawal: settings.minWithdrawal,
        maxWithdrawal: settings.maxWithdrawal,
        withdrawalsDailyLimit: settings.withdrawalsDailyLimit,
        requireVerifiedKyc: settings.requireVerifiedKyc,
      },
    });
  });
}

/**
 * PATCH /api/user/me
 *
 * Only two fields are editable, and they are written with the service role
 * because there is deliberately no UPDATE policy on `profiles`. Role, status,
 * kyc_status, risk_status, currency and referral ownership are therefore
 * impossible to change from the client.
 */
export async function PATCH(request: Request) {
  return runApi(async () => {
    const session = await requireSessionUser();
    const ctx = requestContext(request);

    await enforceRateLimit(
      "user:update",
      session.profile.id,
      20,
      3600,
      "open",
    );

    const input = await parseBody(request, updateProfileSchema);
    if (!input.fullName && !input.phone) {
      throw new ApiError("NOTHING_TO_UPDATE", "There was nothing to update.", 422);
    }

    const patch: Record<string, string> = {};

    if (input.fullName) patch.full_name = input.fullName;

    if (input.phone) {
      const normalised = normalisePhone(input.phone, session.profile.country);
      if (!normalised.ok) {
        throw new ApiError("INVALID_PHONE", normalised.reason, 422, {
          fields: { phone: normalised.reason },
        });
      }
      patch.phone = normalised.e164;
    }

    const admin = createAdminSupabaseClient();
    const { data, error } = await admin
      .from("profiles")
      .update(patch)
      .eq("id", session.profile.id)
      .select("full_name, phone")
      .single<{ full_name: string; phone: string }>();

    if (error) throw error;

    await admin.rpc("write_audit", {
      p_admin_id: null,
      p_user_id: session.profile.id,
      p_action: "PROFILE_UPDATED",
      p_entity: "profile",
      p_entity_id: session.profile.id,
      p_description: "User updated their profile details",
      p_metadata: { fields: Object.keys(patch) },
      p_ip_hash: ctx.ipHash,
      p_user_agent: ctx.userAgent,
    });

    return ok({ profile: data, message: "Your details have been updated." });
  });
}
