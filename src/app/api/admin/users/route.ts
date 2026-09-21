import { z } from "zod";
import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody, parseQuery } from "@/lib/validation/parse";
import { kycStatusSchema, userStatusSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { requestContext } from "@/lib/api/context";
import { listAdminUsers, setKycStatus, setUserStatus } from "@/server/services/admin";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.string().max(40).optional(),
  search: z.string().max(120).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});

const patchSchema = z.discriminatedUnion("action", [
  userStatusSchema.extend({ action: z.literal("status") }),
  kycStatusSchema.extend({ action: z.literal("kyc") }),
]);

/** GET /api/admin/users — paginated user directory. */
export async function GET(request: Request) {
  return runApi(async () => {
    await requireAdmin();
    const query = parseQuery(request.url, querySchema);
    return ok(await listAdminUsers(query));
  });
}

/** PATCH /api/admin/users — change account status or KYC status (audited). */
export async function PATCH(request: Request) {
  return runApi(async () => {
    const session = await requireAdmin();
    const ctx = requestContext(request);

    await enforceRateLimit(
      RATE_LIMITS.adminMutation.bucket,
      session.profile.id,
      RATE_LIMITS.adminMutation.limit,
      RATE_LIMITS.adminMutation.window,
      RATE_LIMITS.adminMutation.mode,
    );

    const body = await parseBody(request, patchSchema);

    if (body.action === "status") {
      await setUserStatus({
        adminId: session.profile.id,
        userId: body.userId,
        status: body.status,
        reason: body.reason,
        ipHash: ctx.ipHash,
        userAgent: ctx.userAgent,
      });
      return ok({ message: `Account status set to ${body.status}.` });
    }

    await setKycStatus({
      adminId: session.profile.id,
      userId: body.userId,
      kycStatus: body.kycStatus,
      note: body.note,
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    });

    return ok({ message: `Verification status set to ${body.kycStatus}.` });
  });
}
