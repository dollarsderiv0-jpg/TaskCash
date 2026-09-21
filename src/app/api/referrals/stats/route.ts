import { requireVerifiedUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { getReferralStats, qualifyingEventCopy, referralLink } from "@/server/services/referrals";

/** GET /api/referrals/stats — configurable rates plus this user's totals. */
export async function GET() {
  return runApi(async () => {
    const session = await requireVerifiedUser("referrals.stats");
    const stats = await getReferralStats(session.profile.id);

    return ok({
      ...stats,
      qualifyingEventDescription: qualifyingEventCopy(stats.qualifyingEvent),
      referralCode: session.profile.referral_code,
      referralLink: referralLink(session.profile.referral_code),
    });
  });
}
