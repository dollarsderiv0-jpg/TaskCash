import { requireVerifiedUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { videoCompleteSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { completeVideoSession } from "@/server/services/videos";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { getWalletOverview } from "@/server/services/wallet";

/**
 * POST /api/videos/complete
 *
 * The ONLY place a video reward is created. The reward amount is read from the
 * campaign record inside the database function; the request body carries just
 * a session token. Duplicate completion returns the original transaction
 * rather than crediting again.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const session = await requireVerifiedUser("videos.complete");

    await enforceRateLimit(
      RATE_LIMITS.videoComplete.bucket,
      session.profile.id,
      RATE_LIMITS.videoComplete.limit,
      RATE_LIMITS.videoComplete.window,
      RATE_LIMITS.videoComplete.mode,
    );

    const input = await parseBody(request, videoCompleteSchema);

    const result = await completeVideoSession({
      userId: session.profile.id,
      sessionToken: input.sessionToken,
    });

    // Return the authoritative post-reward balance so the UI does not have to
    // guess or optimistically increment anything.
    const overview = await getWalletOverview(session.profile.id);
    const admin = createAdminSupabaseClient();
    const { data: transaction } = result.transactionId
      ? await admin
          .from("wallet_transactions")
          .select("id, reference, amount, status, created_at")
          .eq("id", result.transactionId)
          .maybeSingle()
      : { data: null };

    const messages: Record<string, string> = {
      REWARDED: result.duplicate
        ? "This reward was already credited to your wallet."
        : "Reward verified and added to your wallet.",
      REJECTED: "Your watch session could not be verified, so no reward was issued.",
      SUSPENDED: "Your account is not eligible for rewards right now.",
    };

    return ok({
      ...result,
      transaction,
      availableBalance: overview?.wallet.available_balance ?? null,
      lockedBalance: overview?.wallet.locked_balance ?? null,
      message: messages[result.status] ?? "Watch session processed.",
    });
  });
}
