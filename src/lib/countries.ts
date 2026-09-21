/**
 * Country registry.
 *
 * Only countries whose currency is enabled in the `currencies` table can
 * actually transact. The rest are present so enabling a new market later is a
 * data change, not a code change.
 */

export type CountryConfig = {
  code: string;
  name: string;
  currency: string;
  dialCode: string;
  /** National significant number length(s), used for validation. */
  nsnLengths: number[];
  /** Regex for the national part, without the country code. */
  nsnPattern: RegExp;
};

export const COUNTRIES: CountryConfig[] = [
  {
    code: "KE",
    name: "Kenya",
    currency: "KES",
    dialCode: "254",
    nsnLengths: [9],
    nsnPattern: /^[17][0-9]{8}$/,
  },
  {
    code: "UG",
    name: "Uganda",
    currency: "UGX",
    dialCode: "256",
    nsnLengths: [9],
    nsnPattern: /^[37][0-9]{8}$/,
  },
  {
    code: "TZ",
    name: "Tanzania",
    currency: "TZS",
    dialCode: "255",
    nsnLengths: [9],
    nsnPattern: /^[67][0-9]{8}$/,
  },
  {
    code: "RW",
    name: "Rwanda",
    currency: "RWF",
    dialCode: "250",
    nsnLengths: [9],
    nsnPattern: /^7[2389][0-9]{7}$/,
  },
  {
    code: "NG",
    name: "Nigeria",
    currency: "NGN",
    dialCode: "234",
    nsnLengths: [10],
    nsnPattern: /^[789][0-9]{9}$/,
  },
  {
    code: "GH",
    name: "Ghana",
    currency: "GHS",
    dialCode: "233",
    nsnLengths: [9],
    nsnPattern: /^[235][0-9]{8}$/,
  },
  {
    code: "ZA",
    name: "South Africa",
    currency: "ZAR",
    dialCode: "27",
    nsnLengths: [9],
    nsnPattern: /^[678][0-9]{8}$/,
  },
];

export function getCountry(code: string | null | undefined): CountryConfig | null {
  if (!code) return null;
  return COUNTRIES.find((c) => c.code === code.toUpperCase()) ?? null;
}

export function currencyForCountry(code: string | null | undefined): string {
  return getCountry(code)?.currency ?? "KES";
}

export function countryOptions(): CountryConfig[] {
  return COUNTRIES;
}

/**
 * Normalises a user-entered mobile money number to E.164 using the country's
 * dialling code. Mobile money in these markets is always a mobile number, so
 * strict validation here prevents paying the wrong destination.
 */
export function normalisePhone(
  raw: string,
  countryCode: string,
): { ok: true; e164: string } | { ok: false; reason: string } {
  const country = getCountry(countryCode);
  if (!country) return { ok: false, reason: "Unsupported country." };

  const cleaned = raw.replace(/[\s()\-.]/g, "");
  if (!cleaned) return { ok: false, reason: "Enter a phone number." };

  let national: string;

  if (cleaned.startsWith("+")) {
    const digits = cleaned.slice(1);
    if (!digits.startsWith(country.dialCode)) {
      return {
        ok: false,
        reason: `That number is not a ${country.name} number (expected +${country.dialCode}).`,
      };
    }
    national = digits.slice(country.dialCode.length);
  } else if (cleaned.startsWith("00")) {
    const digits = cleaned.slice(2);
    if (!digits.startsWith(country.dialCode)) {
      return {
        ok: false,
        reason: `That number is not a ${country.name} number (expected +${country.dialCode}).`,
      };
    }
    national = digits.slice(country.dialCode.length);
  } else if (cleaned.startsWith(country.dialCode) && cleaned.length > country.nsnLengths[0]) {
    national = cleaned.slice(country.dialCode.length);
  } else {
    // Local format, e.g. 0712 345 678 -> 712345678
    national = cleaned.replace(/^0+/, "");
  }

  if (!country.nsnLengths.includes(national.length) || !country.nsnPattern.test(national)) {
    return { ok: false, reason: "Enter a valid mobile money number." };
  }

  return { ok: true, e164: `+${country.dialCode}${national}` };
}

/** Maps a provider "network code" from the E.164 prefix. */
const NETWORK_BY_PREFIX: Record<string, Record<string, string>> = {
  KE: { "7": "SASAFA", "1": "SASAFA" },
  TZ: { "6": "SASAFA", "7": "SASAFA" },
  UG: { "7": "SASAFA", "3": "SASAFA" },
  RW: { "7": "SASAFA" },
  NG: { "8": "SASAFA", "7": "SASAFA", "9": "SASAFA" },
  GH: { "2": "SASAFA", "5": "SASAFA" },
  ZA: { "6": "SASAFA", "7": "SASAFA", "8": "SASAFA" },
};

/**
 * SasaPay requires an explicit network code. It is derived from the merchant
 * configuration supplied at onboarding; the default below is the widely used
 * "SASAFA" network identifier and should be overridden per market once the
 * merchant account confirms the correct codes.
 */
export function networkCodeForPhone(phone: string, countryCode: string): string {
  const country = getCountry(countryCode);
  if (!country) return "SASAFA";
  const national = phone.startsWith(`+${country.dialCode}`)
    ? phone.slice(country.dialCode.length + 1)
    : phone.replace(/\D/g, "");
  const mapped = NETWORK_BY_PREFIX[country.code]?.[national[0] ?? ""];
  return mapped ?? process.env.SASAPAY_DEFAULT_NETWORK_CODE ?? "SASAFA";
}
