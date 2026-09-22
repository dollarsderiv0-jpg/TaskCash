import { z } from "zod";
import { COUNTRIES } from "@/lib/countries";
import { AD_CATEGORIES, AD_STATUSES, COMPANY_IMAGE_STATUSES } from "@/lib/types";
import { parseVideoSource } from "@/lib/video/source";

/**
 * Server-side input validation.
 *
 * Every write endpoint validates with one of these schemas *before* touching
 * the database. Client-side validation is a convenience only; nothing here is
 * optional. Note what is deliberately absent: no schema accepts a reward
 * amount, a balance, a transaction status or a user role from the client.
 */

const COMMON_WEAK_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "1234567890",
  "qwerty123",
  "letmein",
  "welcome1",
  "admin123",
  "taskcash",
  "iloveyou",
]);

export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters.")
  .max(128, "Use at most 128 characters.")
  .refine((v) => /[a-z]/.test(v), "Include at least one lowercase letter.")
  .refine((v) => /[A-Z]/.test(v), "Include at least one uppercase letter.")
  .refine((v) => /[0-9]/.test(v), "Include at least one number.")
  .refine((v) => !COMMON_WEAK_PASSWORDS.has(v.toLowerCase().trim()), "That password is too common.");

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(5, "Enter your email address.")
  .max(254)
  .email("Enter a valid email address.");

export const countrySchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((v) => COUNTRIES.some((c) => c.code === v), "Select a supported country.");

export const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Select a supported currency.");

export const phoneSchema = z
  .string()
  .trim()
  .min(7, "Enter your phone number.")
  .max(20, "That phone number is too long.");

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

export const registerSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your full name.").max(120),
  email: emailSchema,
  phone: phoneSchema,
  password: passwordSchema,
  country: countrySchema,
  currency: currencySchema,
  referralCode: z
    .string()
    .trim()
    .toUpperCase()
    .max(16)
    .regex(/^TC[A-Z0-9]{3,12}$/, "That referral code is not valid.")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  acceptTerms: z.literal(true, {
    errorMap: () => ({ message: "You must accept the Terms and Privacy Policy." }),
  }),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password.").max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });

/** Correcting the address on an existing account (unverified users). */
export const changeEmailSchema = z.object({ email: emailSchema });

/**
 * Resending a confirmation email. The address is optional: a signed-in caller
 * already has one, and the signed-out branch supplies it here. An empty string
 * is treated as absent so a form that submits `{ email: "" }` still works.
 */
export const resendVerificationSchema = z.object({
  email: emailSchema.optional().or(z.literal("").transform(() => undefined)),
});

export const resetPasswordSchema = z.object({
  password: passwordSchema,
  confirmPassword: z.string(),
}).refine((v) => v.password === v.confirmPassword, {
  message: "Passwords do not match.",
  path: ["confirmPassword"],
});

export const updateProfileSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  phone: phoneSchema.optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

/* -------------------------------------------------------------------------- */
/* Money                                                                      */
/* -------------------------------------------------------------------------- */

/** Amounts arrive as numbers from the client and are re-rounded server-side. */
export const amountSchema = z
  .number({ invalid_type_error: "Enter a valid amount." })
  .finite("Enter a valid amount.")
  .positive("Enter an amount greater than zero.")
  .max(100_000_000, "That amount is too large.");

/*
  Declared here rather than next to the admin schemas further down, because the
  deposit schema below is the first user of it — a `const` referenced above its
  own declaration is a TDZ error at module load, not a type error.
*/
export const idSchema = z.string().uuid("That identifier is not valid.");

export const depositCreateSchema = z.object({
  amount: amountSchema,
  phone: phoneSchema,
  idempotencyKey: z.string().min(8).max(80),
  acceptTerms: z.literal(true, {
    errorMap: () => ({ message: "Please confirm the deposit authorisation." }),
  }),
  /*
    Set when this payment buys a package rather than topping up the wallet.

    Deliberately NOT paired with an amount the client may choose: `amount` above
    is still validated for shape, but `createDeposit` discards it and charges the
    tier's own price when this is present. A client that sends a package id and a
    lower amount gets the tier's price or an error, never the amount it asked for
    — which is the only way "pay for this package" can be safe to expose.
  */
  packageId: idSchema.optional(),
});
export type DepositCreateInput = z.infer<typeof depositCreateSchema>;

export const withdrawalCreateSchema = z.object({
  amount: amountSchema,
  phone: phoneSchema,
  idempotencyKey: z.string().min(8).max(80),
  confirm: z.literal(true, {
    errorMap: () => ({ message: "Please confirm the withdrawal details." }),
  }),
});
export type WithdrawalCreateInput = z.infer<typeof withdrawalCreateSchema>;

/* -------------------------------------------------------------------------- */
/* Videos                                                                     */
/* -------------------------------------------------------------------------- */

export const videoStartSchema = z.object({
  videoId: z.string().uuid("That video is not valid."),
});

export const videoProgressSchema = z.object({
  sessionToken: z.string().uuid("That session is not valid."),
  watchedSeconds: z.number().finite().min(0).max(86_400),
});

export const videoCompleteSchema = z.object({
  sessionToken: z.string().uuid("That session is not valid."),
});

/*
  App installs.

  Only the SOURCE is accepted from the client, and it is restricted to the three
  signals the platform can actually produce. What is installed, whether limits
  are shown, and when the account first got the app are all decided server-side —
  a client cannot report "installed, show me the limits" because there is no
  field here in which to say it.
*/
export const appInstallSchema = z.object({
  source: z.enum(["STANDALONE", "APPINSTALLED", "MANUAL"]).default("MANUAL"),
});

/* -------------------------------------------------------------------------- */
/* Admin                                                                      */
/* -------------------------------------------------------------------------- */


export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).optional(),
  status: z.string().trim().max(40).optional(),
  from: z.string().trim().max(30).optional(),
  to: z.string().trim().max(30).optional(),
});

export const adminRejectWithdrawalSchema = z.object({
  reason: z.string().trim().min(5, "Provide a reason for the rejection.").max(500),
});

export const adminApproveWithdrawalSchema = z.object({
  /** Optional signed confirmation for high-value approvals. */
  confirmationToken: z.string().max(2048).optional(),
  adminPasswordConfirmed: z.boolean().optional(),
});

export const adminAdjustWalletSchema = z.object({
  userId: idSchema,
  amount: z.number().finite().refine((v) => v !== 0, "Enter a non-zero amount."),
  reason: z.string().trim().min(5, "Provide a reason.").max(500),
});

export const videoUpsertSchema = z.object({
  id: idSchema.optional(),
  campaignId: idSchema.nullable().optional(),
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  videoUrl: z
    .string()
    .trim()
    .url("Enter a valid video URL.")
    /*
      A YouTube link that points at a channel, a search or a playlist is a valid
      URL but is not a playable video. Refusing it here means an administrator
      finds out immediately, instead of saving a row whose player is broken and
      only discovering it when a user opens it.
    */
    .refine((value) => parseVideoSource(value).kind !== "unplayable", {
      message:
        "That YouTube link is not a single video. Paste the video's own URL, like https://www.youtube.com/watch?v=…",
    }),
  thumbnailUrl: z.string().trim().url("Enter a valid thumbnail URL.").optional().nullable().or(z.literal("").transform(() => null)),
  durationSeconds: z.coerce.number().int().min(5).max(36_000),
  requiredWatchSeconds: z.coerce.number().int().min(1).max(36_000),
  rewardAmount: z.coerce.number().min(0).max(1_000_000),
  currency: currencySchema,
  dailyLimit: z.coerce.number().int().min(0).max(1000),
  totalViewLimit: z.coerce.number().int().min(1).max(10_000_000).nullable().optional(),
  status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "EXPIRED", "COMPLETED", "SUSPENDED"]),
}).refine((v) => v.requiredWatchSeconds <= v.durationSeconds, {
  message: "Required watch time cannot exceed the video duration.",
  path: ["requiredWatchSeconds"],
});
export type VideoUpsertInput = z.infer<typeof videoUpsertSchema>;

export const campaignUpsertSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(2000).optional().nullable(),
  advertiser: z.string().trim().max(160).optional().nullable(),
  budget: z.coerce.number().min(0).max(1_000_000_000),
  rewardPerView: z.coerce.number().min(0).max(1_000_000),
  maxViews: z.coerce.number().int().min(1).max(100_000_000).nullable().optional(),
  startAt: z.string().trim().max(40).optional().nullable(),
  endAt: z.string().trim().max(40).optional().nullable(),
  status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "EXPIRED", "COMPLETED", "SUSPENDED"]),
});
export type CampaignUpsertInput = z.infer<typeof campaignUpsertSchema>;

/**
 * Packages. Admin-only, so the bounds are generous — but they exist, because
 * `dailyEarningCap` is the figure that decides how much real money the platform
 * pays out per user per day, and a typo of an extra zero there is an unbounded
 * liability rather than a cosmetic mistake.
 */
export const packageUpsertSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(2, "Enter a package name.").max(120),
  description: z.string().trim().max(2000).optional().nullable(),
  price: z.coerce.number().positive("Enter a price greater than zero.").max(10_000_000),
  currency: currencySchema,
  /*
    Zero is accepted HERE but the database refuses to SELL such a package
    (PACKAGE_NOT_AVAILABLE): a tier with no configured allowance is one an admin
    is still setting up, not one a user may pay for.
  */
  dailyEarningCap: z.coerce.number().min(0).max(10_000_000),
  /*
    The other two terms, both optional and both POSITIVE when present. `null` is
    "no ceiling" / "never lapses"; 0 is neither, and the database's check constraint
    rejects it outright — a lifetime cap of 0 is a package allowed to pay nothing,
    and a term of 0 days is one that expires the moment it is bought.
  */
  lifetimeEarningCap: z.coerce
    .number()
    .positive("A total limit must be greater than zero, or left blank.")
    .max(100_000_000)
    .optional()
    .nullable(),
  durationDays: z.coerce
    .number()
    .int("Use whole days.")
    .positive("A period must be at least one day, or left blank.")
    .max(3650)
    .optional()
    .nullable(),
  status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"]),
  sortOrder: z.coerce.number().int().min(0).max(100_000),
  /** The videos this tier unlocks. A video may belong to at most one package. */
  videoIds: z.array(idSchema).max(10_000).optional(),
});
export type PackageUpsertInput = z.infer<typeof packageUpsertSchema>;

export const packageDeleteSchema = z.object({
  id: idSchema,
});

/** Buying a package. The price and the cap are read from the database, not here. */
export const packagePurchaseSchema = z.object({
  packageId: idSchema,
});

/**
 * An advertisement — creative for the display-only sponsored gallery.
 *
 * `imageUrl` must be absolute http(s) rather than any string, because the
 * browser loads it directly and the database enforces the same shape. Both
 * bounds are optional and independent: an advert may run from now on, until a
 * date, or between two dates.
 */
export const advertisementUpsertSchema = z
  .object({
    id: idSchema.optional(),
    title: z.string().trim().min(2, "Give the advertisement a title.").max(160),
    description: z.string().trim().max(2000).optional().nullable(),
    advertiser: z.string().trim().max(160).optional().nullable(),
    imageUrl: z
      .string()
      .trim()
      .url("Enter the full address of the image, starting with https://")
      .max(2048)
      .refine((value) => /^https?:\/\//i.test(value), {
        message: "The image address must start with http:// or https://",
      }),
    linkUrl: z
      .string()
      .trim()
      .url("Enter a full web address, starting with https://")
      .max(2048)
      .refine((value) => /^https?:\/\//i.test(value), {
        message: "The link must start with http:// or https://",
      })
      .optional()
      .nullable()
      .or(z.literal("").transform(() => null)),
    /*
      Not required, because an operator should not be blocked from publishing.
      The gallery always announces something: when this is empty it falls back
      to the title, so an image is never described as nothing at all.
    */
    altText: z
      .string()
      .trim()
      .min(3, "Describe the image in a few words, or leave it blank to use the title.")
      .max(300)
      .optional()
      .nullable()
      .or(z.literal("").transform(() => null)),
    category: z.enum(AD_CATEGORIES),
    sortOrder: z.coerce.number().int().min(0).max(100_000),
    status: z.enum(AD_STATUSES),
    startsAt: z.string().trim().max(40).optional().nullable(),
    endsAt: z.string().trim().max(40).optional().nullable(),
  })
  .refine(
    (value) => {
      /*
        Narrowed explicitly rather than read off the object: these two fields
        are `optional().nullable()`, and the union their inference produces is
        not something `new Date()` accepts without a cast.
      */
      const { startsAt, endsAt } = value as { startsAt?: unknown; endsAt?: unknown };
      if (typeof startsAt !== "string" || typeof endsAt !== "string") return true;
      if (!startsAt || !endsAt) return true;
      return new Date(endsAt).getTime() > new Date(startsAt).getTime();
    },
    { message: "The end date must be after the start date.", path: ["endsAt"] },
  );
export type AdvertisementUpsertInput = z.infer<typeof advertisementUpsertSchema>;

export const advertisementDeleteSchema = z.object({
  id: idSchema,
});

/*
  Company images — the pictures of the companies behind the platform.

  `imageUrl` accepts either an https address or a site-local `/path`, because an
  uploaded picture arrives as a Storage public URL while a picture shipped with
  the app is referenced as `/companies/…`. The single-slash rule is deliberate:
  `//host/x.png` is PROTOCOL RELATIVE, so allowing a bare leading slash would
  turn a local path into a third-party fetch. Migration 0016 enforces exactly the
  same shape, so a row that passes here cannot be rejected by the database.
*/
const companyImageUrl = z
  .string()
  .trim()
  .min(1, "Upload a picture or paste its address.")
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value) || /^\/[^/]/.test(value), {
    message: "Enter an https:// address, or a /path starting with a single slash",
  });

export const companyImageUpsertSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(2, "Give the company a name.").max(120),
  caption: z
    .string()
    .trim()
    .max(300)
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  imageUrl: companyImageUrl,
  /*
    The bucket path of an uploaded object, so that deleting the row can delete the
    file too. Null for a pasted URL: this app did not put that file in our bucket
    and must not pretend it may remove it.
  */
  storagePath: z
    .string()
    .trim()
    .max(512)
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  linkUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => /^https?:\/\//i.test(value) || /^\/[^/]/.test(value), {
      message: "Enter an https:// address, or a /path starting with a single slash",
    })
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  sortOrder: z.coerce.number().int().min(0).max(100_000),
  status: z.enum(COMPANY_IMAGE_STATUSES),
});
export type CompanyImageUpsertInput = z.infer<typeof companyImageUpsertSchema>;

export const companyImageDeleteSchema = z.object({
  id: idSchema,
});

export const settingsUpdateSchema = z.object({
  updates: z
    .array(
      z.object({
        key: z.string().trim().min(2).max(120),
        value: z.union([z.string(), z.number(), z.boolean(), z.record(z.unknown()), z.array(z.unknown())]),
      }),
    )
    .min(1)
    .max(100),
});

export const fraudReviewSchema = z.object({
  eventId: idSchema,
  status: z.enum(["OPEN", "REVIEWING", "CLEARED", "CONFIRMED"]),
  note: z.string().trim().max(500).optional(),
  /** Explicit, audited risk-status change. Never automatic. */
  riskStatus: z.enum(["NORMAL", "REVIEW", "RESTRICTED", "SUSPENDED"]).optional(),
});

export const userStatusSchema = z.object({
  userId: idSchema,
  status: z.enum(["ACTIVE", "RESTRICTED", "SUSPENDED", "CLOSED"]),
  reason: z.string().trim().min(5).max(500),
});

export const kycStatusSchema = z.object({
  userId: idSchema,
  kycStatus: z.enum(["NOT_STARTED", "PENDING", "VERIFIED", "REJECTED", "REQUIRES_REVIEW"]),
  note: z.string().trim().max(500).optional(),
});

/* -------------------------------------------------------------------------- */
/* Support                                                                    */
/* -------------------------------------------------------------------------- */

const SUPPORT_CATEGORIES = [
  "GENERAL",
  "PAYMENT",
  "DEPOSIT",
  "WITHDRAWAL",
  "ACCOUNT",
  "REWARDS",
  "REFERRALS",
  "OTHER",
] as const;

export const supportTicketSchema = z.object({
  category: z.enum(SUPPORT_CATEGORIES),
  subject: z
    .string()
    .trim()
    .min(3, "Give your request a short title.")
    .max(140, "Please keep the title under 140 characters."),
  message: z
    .string()
    .trim()
    .min(10, "Tell us what happened, in a sentence or two.")
    .max(5000, "Please keep your message under 5000 characters."),
  /**
   * An optional reference the user is asking about (a withdrawal or transaction
   * reference they can see). Free text because the user copies it from a
   * screen; it is validated to a safe shape rather than resolved here.
   */
  reference: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Za-z0-9._-]*$/, "References only contain letters, numbers, dots, dashes and underscores.")
    .optional(),
});

export const supportReplySchema = z.object({
  ticketId: idSchema,
  message: z.string().trim().min(1, "Write a message.").max(5000),
});

/**
 * Administrator reply and/or status change.
 *
 * Both parts are optional individually — an administrator may answer without
 * changing the status, or close a ticket without writing anything — but not both
 * at once, which would be a no-op request that still wrote an audit record.
 */
export const supportAdminReplySchema = z
  .object({
    message: z.string().trim().max(5000).optional(),
    status: z.enum(["OPEN", "IN_REVIEW", "RESOLVED", "CLOSED"]).optional(),
  })
  .refine((value) => Boolean(value.message) || Boolean(value.status), {
    message: "Write a reply, change the status, or both.",
  });

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export type FieldErrors = Record<string, string>;

export function fieldErrorsFrom(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
