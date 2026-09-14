/**
 * Country + currency catalog (single source of truth for the backend).
 *
 * Format: "ISO2:Country name:CurrencyISO" entries parsed at load.
 * TaskCash does NOT convert between currencies: each country has its own
 * configured amounts (see backend/services/rewards.js). This catalog only
 * declares which currency an account from a country uses.
 */
const DATA = `
AD:Andorra:EUR;AE:United Arab Emirates:AED;AF:Afghanistan:AFN;AG:Antigua and Barbuda:XCD;
AI:Anguilla:XCD;AL:Albania:ALL;AM:Armenia:AMD;AO:Angola:AOA;AR:Argentina:ARS;AS:American Samoa:USD;
AT:Austria:EUR;AU:Australia:AUD;AW:Aruba:AWG;AZ:Azerbaijan:AZN;BA:Bosnia and Herzegovina:BAM;
BB:Barbados:BBD;BD:Bangladesh:BDT;BE:Belgium:EUR;BF:Burkina Faso:XOF;BG:Bulgaria:BGN;BH:Bahrain:BHD;
BI:Burundi:BIF;BJ:Benin:XOF;BL:Saint Barthelemy:EUR;BM:Bermuda:BMD;BN:Brunei:BND;BO:Bolivia:BOB;
BR:Brazil:BRL;BS:Bahamas:BSD;BT:Bhutan:BTN;BW:Botswana:BWP;BY:Belarus:BYN;BZ:Belize:BZD;
CA:Canada:CAD;CD:DR Congo:CDF;CF:Central African Republic:XAF;CG:Congo:XAF;CH:Switzerland:CHF;
CI:Cote d'Ivoire:XOF;CK:Cook Islands:NZD;CL:Chile:CLP;CM:Cameroon:XAF;CN:China:CNY;CO:Colombia:COP;
CR:Costa Rica:CRC;CU:Cuba:CUP;CV:Cabo Verde:CVE;CW:Curacao:ANG;CY:Cyprus:EUR;CZ:Czechia:CZK;
DE:Germany:EUR;DJ:Djibouti:DJF;DK:Denmark:DKK;DM:Dominica:XCD;DO:Dominican Republic:DOP;
DZ:Algeria:DZD;EC:Ecuador:USD;EE:Estonia:EUR;EG:Egypt:EGP;ER:Eritrea:ERN;ES:Spain:EUR;
ET:Ethiopia:ETB;FI:Finland:EUR;FJ:Fiji:FJD;FK:Falkland Islands:FKP;FM:Micronesia:USD;
FO:Faroe Islands:DKK;FR:France:EUR;GA:Gabon:XAF;GB:United Kingdom:GBP;GD:Grenada:XCD;
GE:Georgia:GEL;GH:Ghana:GHS;GI:Gibraltar:GIP;GL:Greenland:DKK;GM:Gambia:GMD;GN:Guinea:GNF;
GP:Guadeloupe:EUR;GQ:Equatorial Guinea:XAF;GR:Greece:EUR;GT:Guatemala:GTQ;GU:Guam:USD;
GW:Guinea-Bissau:XOF;GY:Guyana:GYD;HK:Hong Kong:HKD;HN:Honduras:HNL;HR:Croatia:EUR;
HT:Haiti:HTG;HU:Hungary:HUF;ID:Indonesia:IDR;IE:Ireland:EUR;IL:Israel:ILS;IN:India:INR;
IQ:Iraq:IQD;IR:Iran:IRR;IS:Iceland:ISK;IT:Italy:EUR;JM:Jamaica:JMD;JO:Jordan:JOD;
JP:Japan:JPY;KE:Kenya:KES;KG:Kyrgyzstan:KGS;KH:Cambodia:KHR;KI:Kiribati:AUD;KM:Comoros:KMF;
KN:Saint Kitts and Nevis:XCD;KP:North Korea:KPW;KR:South Korea:KRW;KW:Kuwait:KWD;
KY:Cayman Islands:KYD;KZ:Kazakhstan:KZT;LA:Laos:LAK;LB:Lebanon:LBP;LC:Saint Lucia:XCD;
LI:Liechtenstein:CHF;LK:Sri Lanka:LKR;LR:Liberia:LRD;LS:Lesotho:LSL;LT:Lithuania:EUR;
LU:Luxembourg:EUR;LV:Latvia:EUR;LY:Libya:LYD;MA:Morocco:MAD;MC:Monaco:EUR;MD:Moldova:MDL;
ME:Montenegro:EUR;MG:Madagascar:MGA;MH:Marshall Islands:USD;MK:North Macedonia:MKD;
ML:Mali:XOF;MM:Myanmar:MMK;MN:Mongolia:MNT;MO:Macao:MOP;MP:Northern Mariana Islands:USD;
MQ:Martinique:EUR;MR:Mauritania:MRU;MS:Montserrat:XCD;MT:Malta:EUR;MU:Mauritius:MUR;
MV:Maldives:MVR;MW:Malawi:MWK;MX:Mexico:MXN;MY:Malaysia:MYR;MZ:Mozambique:MZN;
NA:Namibia:NAD;NC:New Caledonia:XPF;NE:Niger:XOF;NF:Norfolk Island:AUD;NG:Nigeria:NGN;
NI:Nicaragua:NIO;NL:Netherlands:EUR;NO:Norway:NOK;NP:Nepal:NPR;NR:Nauru:AUD;NU:Niue:NZD;
NZ:New Zealand:NZD;OM:Oman:OMR;PA:Panama:PAB;PE:Peru:PEN;PF:French Polynesia:XPF;
PG:Papua New Guinea:PGK;PH:Philippines:PHP;PK:Pakistan:PKR;PL:Poland:PLN;PM:Saint Pierre and Miquelon:EUR;
PR:Puerto Rico:USD;PS:Palestine:ILS;PT:Portugal:EUR;PW:Palau:USD;PY:Paraguay:PYG;
QA:Qatar:QAR;RE:Reunion:EUR;RO:Romania:RON;RS:Serbia:RSD;RU:Russia:RUB;RW:Rwanda:RWF;
SA:Saudi Arabia:SAR;SB:Solomon Islands:SBD;SC:Seychelles:SCR;SD:Sudan:SDG;SE:Sweden:SEK;
SG:Singapore:SGD;SI:Slovenia:EUR;SK:Slovakia:EUR;SL:Sierra Leone:SLE;SM:San Marino:EUR;
SN:Senegal:XOF;SO:Somalia:SOS;SR:Suriname:SRD;SS:South Sudan:SSP;ST:Sao Tome and Principe:STN;
SV:El Salvador:USD;SX:Sint Maarten:ANG;SY:Syria:SYP;SZ:Eswatini:SZL;TC:Turks and Caicos Islands:USD;
TD:Chad:XAF;TG:Togo:XOF;TH:Thailand:THB;TJ:Tajikistan:TJS;TL:Timor-Leste:USD;
TM:Turkmenistan:TMT;TN:Tunisia:TND;TO:Tonga:TOP;TR:Turkiye:TRY;TT:Trinidad and Tobago:TTD;
TV:Tuvalu:AUD;TW:Taiwan:TWD;TZ:Tanzania:TZS;UA:Ukraine:UAH;UG:Uganda:UGX;
US:United States:USD;UY:Uruguay:UYU;UZ:Uzbekistan:UZS;VA:Vatican City:EUR;
VC:Saint Vincent and the Grenadines:XCD;VE:Venezuela:VES;VG:British Virgin Islands:USD;
VI:U.S. Virgin Islands:USD;VN:Vietnam:VND;VU:Vanuatu:VUV;WF:Wallis and Futuna:XPF;
WS:Samoa:WST;XK:Kosovo:EUR;YE:Yemen:YER;ZA:South Africa:ZAR;ZM:Zambia:ZMW;ZW:Zimbabwe:ZWL
`;

const countries = DATA.split(/[;\n]+/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const [code, name, currency] = entry.split(':');
    return { code, name, currency_code: currency };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const byCode = new Map(countries.map((c) => [c.code, c]));

function getCountry(code) {
  if (!code) return null;
  return byCode.get(String(code).toUpperCase()) || null;
}

/** Resolve country + currency fields for a user record. */
function resolveUserCountry(code) {
  const c = getCountry(code);
  if (!c) return null;
  return { country: c.name, country_code: c.code, currency: c.currency_code, currency_code: c.currency_code };
}

/**
 * Country-aware payment method registry.
 * Only genuinely implemented integrations are listed as implemented: true.
 * Everything else must be surfaced as "Coming soon" — never faked.
 * M-Pesa (Daraja) is implemented for Kenya only.
 */
const DEPOSIT_METHODS = {
  KE: [{ id: 'mpesa', name: 'M-Pesa (STK Push)', implemented: true }],
};

const WITHDRAWAL_METHODS = {
  KE: [
    { id: 'mpesa', name: 'M-Pesa', implemented: true },
    { id: 'bank', name: 'Bank transfer', implemented: true },
  ],
};
const WITHDRAWAL_METHODS_DEFAULT = [
  { id: 'bank', name: 'Bank transfer', implemented: true },
];

function depositMethods(countryCode) {
  return DEPOSIT_METHODS[String(countryCode || '').toUpperCase()] || [];
}

function withdrawalMethods(countryCode) {
  const cc = String(countryCode || '').toUpperCase();
  return WITHDRAWAL_METHODS[cc] || WITHDRAWAL_METHODS_DEFAULT;
}

/** True when the user's country supports the M-Pesa (Daraja) integration. */
function isMpesaCountry(countryCode) {
  return String(countryCode || '').toUpperCase() === 'KE';
}

module.exports = { countries, getCountry, resolveUserCountry, depositMethods, withdrawalMethods, isMpesaCountry };
