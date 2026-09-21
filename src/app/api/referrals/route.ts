import { requireSessionUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { listReferrals, referralLink } from "@/server/services/referrals";

/**
 * GET /api/referrals
 *
 * Referred users are returned masked. A referrer can see that someone they
 * invited qualified and what commission they earned — never that person's
 * phone number, email address or balance.
 */
export async function GET() {
  return runApi(async () => {
    const session = await requireSessionUser();
    const referrals = await listReferrals(session.profile.id);

    return ok({
      referralCode: session.profile.referral_code,
      referralLink: referralLink(session.profile.referral_code),
      referrals,
    });
  });
}
