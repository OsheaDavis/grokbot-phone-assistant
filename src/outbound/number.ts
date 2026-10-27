/**
 * Strict US dial numbers for outbound.
 * The string must already be canonical E.164. Spaces, dashes, fullwidth
 * digits, and other formatting are rejected rather than normalized, so a
 * trick that would collapse to a real number cannot become the number on
 * the card or the number that is dialed.
 *
 * Area codes are deny-by-default. A +1 number is accepted only when its
 * area code is an in-service geographic code for the 50 states or the
 * District of Columbia.
 *
 * Source: NANPA NPA report, file date 10/19/2026, retrieved 2026-10-19.
 * https://www.nanpa.com/reports/npa-reports
 * https://reports.nanpa.com/public/npa_report.csv
 * Filter: USE=G, COUNTRY=US, IN_SERVICE=Y, and LOCATION is a state or DC.
 * That drops Canada, Caribbean NANP countries, US territories (PR, VI, GU,
 * AS, CNMI), toll-free 800/833/844/855/866/877/888, 5XX and other
 * non-geographic service codes, 900/976, N11, and reserved or not-yet-in-service codes.
 */

export type NumberRefusal = "invalid_number" | "non_us" | "premium";

export type NumberCheck =
  | { ok: true; e164: string }
  | { ok: false; reason: NumberRefusal };

/** Caller-paid. 976 is also the historic pay-per-call exchange inside a real area code. */
const PREMIUM_NPA = new Set(["900", "976"]);

/** Toll-free is out of scope for v1. These are not geographic subscriber codes. */
const TOLL_FREE_NPA = new Set(["800", "833", "844", "855", "866", "877", "888"]);

/**
 * In-service geographic NPAs for the 50 states and DC, from the NANPA file
 * dated 10/19/2026. Anything absent is rejected.
 */
const US_GEOGRAPHIC_NPA = new Set([
  "201", "202", "203", "205", "206", "207", "208", "209", "210", "212", "213", "214",
  "215", "216", "217", "218", "219", "220", "223", "224", "225", "227", "228", "229",
  "231", "234", "235", "239", "240", "248", "251", "252", "253", "254", "256", "260",
  "262", "267", "269", "270", "272", "274", "276", "279", "281", "283", "301", "302",
  "303", "304", "305", "307", "308", "309", "310", "312", "313", "314", "315", "316",
  "317", "318", "319", "320", "321", "323", "324", "325", "326", "327", "329", "330",
  "331", "332", "334", "336", "337", "339", "341", "346", "347", "350", "351", "352",
  "353", "357", "360", "361", "363", "364", "369", "380", "385", "386", "401", "402",
  "404", "405", "406", "407", "408", "409", "410", "412", "413", "414", "415", "417",
  "419", "423", "424", "425", "430", "432", "434", "435", "436", "440", "442", "443",
  "445", "447", "448", "457", "458", "463", "464", "465", "469", "470", "471", "472",
  "475", "478", "479", "480", "483", "484", "501", "502", "503", "504", "505", "507",
  "508", "509", "510", "512", "513", "515", "516", "517", "518", "520", "530", "531",
  "534", "539", "540", "541", "551", "557", "559", "561", "562", "563", "564", "567",
  "570", "571", "572", "573", "574", "575", "580", "582", "585", "586", "601", "602",
  "603", "605", "606", "607", "608", "609", "610", "612", "614", "615", "616", "617",
  "618", "619", "620", "621", "623", "624", "626", "628", "629", "630", "631", "636",
  "640", "641", "645", "646", "650", "651", "656", "657", "659", "660", "661", "662",
  "667", "669", "678", "679", "680", "681", "682", "686", "689", "701", "702", "703",
  "704", "706", "707", "708", "712", "713", "714", "715", "716", "717", "718", "719",
  "720", "724", "725", "726", "727", "728", "729", "730", "731", "732", "734", "737",
  "738", "740", "743", "747", "748", "754", "757", "760", "762", "763", "765", "769",
  "770", "771", "772", "773", "774", "775", "779", "781", "785", "786", "801", "802",
  "803", "804", "805", "806", "808", "810", "812", "813", "814", "815", "816", "817",
  "818", "820", "821", "826", "828", "830", "831", "832", "835", "837", "838", "839",
  "840", "843", "845", "847", "848", "850", "854", "856", "857", "858", "859", "860",
  "861", "862", "863", "864", "865", "870", "872", "878", "901", "903", "904", "906",
  "907", "908", "909", "910", "912", "913", "914", "915", "916", "917", "918", "919",
  "920", "924", "925", "928", "929", "930", "931", "934", "936", "937", "938", "940",
  "941", "943", "945", "947", "948", "949", "951", "952", "954", "956", "959", "970",
  "971", "972", "973", "975", "978", "979", "980", "983", "984", "985", "986", "989",
]);

/** +1 and exactly ten NANP digits. NPA and NXX cannot start with 0 or 1. */
const CANONICAL_US = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

function premium(npa: string, nxx: string): boolean {
  if (PREMIUM_NPA.has(npa)) return true;
  if (nxx === "976") return true;
  return false;
}

export function validateUsDialNumber(input: string): NumberCheck {
  if (typeof input !== "string" || input.length === 0 || input.length > 16) {
    return { ok: false, reason: "invalid_number" };
  }
  // Any character other than "+" and an ASCII digit is a formatting trick.
  if (!/^\+\d+$/.test(input)) {
    return { ok: false, reason: "invalid_number" };
  }
  if (!input.startsWith("+1")) {
    return { ok: false, reason: "non_us" };
  }
  if (!CANONICAL_US.test(input)) {
    return { ok: false, reason: "invalid_number" };
  }
  const npa = input.slice(2, 5);
  const nxx = input.slice(5, 8);
  if (premium(npa, nxx)) {
    return { ok: false, reason: "premium" };
  }
  if (TOLL_FREE_NPA.has(npa)) {
    return { ok: false, reason: "invalid_number" };
  }
  if (!US_GEOGRAPHIC_NPA.has(npa)) {
    return { ok: false, reason: "non_us" };
  }
  return { ok: true, e164: input };
}
