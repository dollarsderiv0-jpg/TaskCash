import { requireVerifiedUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { depositCreateSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { requestContext } from "@/lib/api/context";
import { createDeposit } from "@/server/services/deposits";
import { getWalletOverview } from "@/server/services/wallet";

/**
 * POST /api/deposits/create
 *
 * Records a PENDING deposit and asks SasaPay to collect. Nothing is credited
 * here — and nothing is credited merely because a client says the payment
 * succeeded. Crediting happens only in verifyAndSettleDeposit() after the
 * provider independently confirms the transaction.
 *
 * One request serves both kinds of payment: a wallet top-up, and payment for a
 * package. They differ only by `packageId`, and the difference matters in two
 * places — the amount becomes the tier's price instead of the request's, and a
 * confirmed payment activates the package in the same settlement that credits
 * the wallet.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const session = await requireVerifiedUser("deposits.create");
    const ctx = requestContext(request);

    await enforceRateLimit(
      RATE_LIMITS.depositCreate.bucket,
      session.profile.id,
      RATE_LIMITS.depositCreate.limit,
      RATE_LIMITS.depositCreate.window,
      RATE_LIMITS.depositCreate.mode,
    );

    const input = await parseBody(request, depositCreateSchema);

    const result = await createDeposit({
      profile: session.profile,
      wallet: session.wallet,
      amount: input.amount,
      phone: input.phone,
      idempotencyKey: input.idempotencyKey,
      ipHash: ctx.ipHash,
      packageId: input.packageId ?? null,
    });

    const overview = await getWalletOverview(session.profile.id);

    return ok({
      ...result,
      availableBalance: overview?.wallet.available_balance ?? null,
      note: result.packageName
        ? `${result.packageName} activates only after the payment provider confirms the payment. ` +
          "A package buys access to platform services and is not an investment product."
        : "Your wallet will only be credited after the payment provider confirms the transaction. " +
          "Deposits are payment for platform services and are not an investment product.",
    });
  });
}
