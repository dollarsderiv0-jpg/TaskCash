import { requireVerifiedUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { packagePurchaseSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { purchasePackage } from "@/server/services/packages";

/**
 * POST /api/packages/purchase
 *
 * The client sends a package id — nothing else. There is deliberately no amount
 * in the request body: the price is read from the package row inside
 * `package_purchase`, under a lock, and the debit happens through the ledger in
 * the same transaction that records the purchase.
 *
 * A success means the wallet was really debited and the response carries the
 * authoritative post-purchase balance, so the UI never has to guess what the
 * user has left.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const session = await requireVerifiedUser("packages.purchase");

    await enforceRateLimit(
      RATE_LIMITS.packagePurchase.bucket,
      session.profile.id,
      RATE_LIMITS.packagePurchase.limit,
      RATE_LIMITS.packagePurchase.window,
      RATE_LIMITS.packagePurchase.mode,
    );

    const input = await parseBody(request, packagePurchaseSchema);

    const purchase = await purchasePackage({
      userId: session.profile.id,
      packageId: input.packageId,
    });

    return ok({
      purchase,
      message: `${purchase.packageName} is now active.`,
    });
  });
}
