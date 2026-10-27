import type { RegisterEntry } from "./greenbook.js";

export type Confidence = "high" | "medium" | "low" | "not_visible";
export type ProductType = "drug" | "herbal" | "food" | "drink" | "cosmetic" | "device" | "other";

export interface PackReading {
  productName: string | null;
  activeIngredient?: string | null;
  strength?: string | null;
  productType: ProductType;
  nafdacNo: string | null;
  nafdacConfidence: Confidence;
  batchNo?: string | null;
  expiry?: string | null;
  manufacturer?: string | null;
  packagingConcerns?: string[];
}

export type VerdictCode = "registered_match" | "different_product" | "not_found" | "unreadable" | "no_number" | "not_covered" | "lookup_failed";

export interface Verdict {
  code: VerdictCode;
  text: string;
  flags: string[];
}

export const DISCLAIMER = "This checks registration only. If in doubt, ask a pharmacist.";

/** The Greenbook lists drugs, vaccines, devices, veterinary products, herbals and disinfectants, not food or cosmetics. */
const NOT_IN_GREENBOOK: ProductType[] = ["food", "drink", "cosmetic"];

const STOPWORDS = new Set(
  "tablet tablets tab tabs caplet caplets capsule capsules caps syrup suspension susp oral solution injection inj cream ointment gel drops drop powder sachet sachets elixir mixture film coated plus forte extra children child kids adult adults junior baby for and with the of mg ml mcg g kg iu bp usp".split(" "),
);

function tokens(...parts: (string | null | undefined)[]): string[] {
  return parts
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** "exact" when a name or ingredient word matches, "close" when only a near spelling matches. */
export function nameMatch(pack: PackReading, entry: RegisterEntry): "exact" | "close" | "none" {
  const packWords = tokens(pack.productName, pack.activeIngredient);
  const registerWords = tokens(entry.productName, entry.ingredient);
  if (packWords.some((w) => registerWords.includes(w))) return "exact";
  const close = packWords.some((w) => registerWords.some((r) => Math.min(w.length, r.length) >= 6 && editDistance(w, r) <= 1));
  return close ? "close" : "none";
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Reads an expiry as printed ("10/2027", "OCT 2027", "2027-10", "31/10/2027") and returns the
 * last moment it is still in date, or null when it cannot be read.
 */
export function parseExpiry(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/exp(iry)?\.?|date|:/g, " ").trim();
  let month: number | undefined;
  let year: number | undefined;
  let day: number | undefined;

  const named = s.match(/([a-z]{3,4})[a-z]*[\s.\-/]*(\d{2,4})/);
  if (named && MONTHS[named[1]]) {
    month = MONTHS[named[1]];
    year = Number(named[2]);
  } else {
    const nums = s.match(/\d+/g)?.map(Number) ?? [];
    if (nums.length === 2) [month, year] = nums[0] > 12 ? [nums[1], nums[0]] : [nums[0], nums[1]];
    else if (nums.length === 3) [day, month, year] = nums[0] > 31 ? [nums[2], nums[1], nums[0]] : [nums[0], nums[1], nums[2]];
  }
  if (!month || !year || month < 1 || month > 12) return null;
  if (year < 100) year += 2000;
  // Packs that print only month and year are in date until the end of that month.
  return day ? new Date(Date.UTC(year, month - 1, day, 23, 59, 59)) : new Date(Date.UTC(year, month, 0, 23, 59, 59));
}

function describe(e: RegisterEntry): string {
  const detail = [e.ingredient, e.strength].filter((x) => x && x !== "NA").join(" ");
  return detail ? `${e.productName} (${detail})` : e.productName;
}

export function decide(pack: PackReading, lookup: { ok: true; entries: RegisterEntry[] } | { ok: false }, now = new Date()): Verdict {
  const flags: string[] = [];
  const expiry = parseExpiry(pack.expiry);
  if (expiry && expiry.getTime() < now.getTime()) flags.push(`Expired: the pack says EXP ${pack.expiry}.`);
  for (const c of pack.packagingConcerns ?? []) flags.push(`Packaging: ${c}`);

  const finish = (code: VerdictCode, text: string): Verdict => ({ code, text, flags });

  if (!pack.nafdacNo || pack.nafdacConfidence === "not_visible") {
    return finish(
      "no_number",
      "*No NAFDAC number found* on what you sent. Send a photo of every side of the pack. Drugs sold in Nigeria must carry a NAFDAC registration number, so a missing one is a warning sign.",
    );
  }
  if (pack.nafdacConfidence === "low") {
    return finish("unreadable", `*I could not read the NAFDAC number clearly* (it looked like ${pack.nafdacNo}). Please send a sharp, close photo of that side in good light.`);
  }
  // Missing details only matter once the pack can actually be checked.
  if (!pack.batchNo) flags.push("No batch number found on the pack.");
  if (!pack.expiry) flags.push("No expiry date found on the pack.");

  if (!lookup.ok) return finish("lookup_failed", "*I could not reach the NAFDAC Greenbook just now.* Please send the check again in a few minutes.");

  const no = pack.nafdacNo;
  if (!lookup.entries.length) {
    if (NOT_IN_GREENBOOK.includes(pack.productType)) {
      return finish(
        "not_covered",
        `*I cannot verify this one online.* The NAFDAC Greenbook lists drugs and similar products, not ${pack.productType === "cosmetic" ? "cosmetics" : "food and drinks"}, so NAFDAC ${no} is not something I can check there.`,
      );
    }
    return finish("not_found", `*Likely fake or unregistered.* NAFDAC ${no} is not on the NAFDAC Greenbook.`);
  }

  const scored = lookup.entries.map((e) => ({ e, m: nameMatch(pack, e) }));
  const best = scored.find((s) => s.m === "exact") ?? scored.find((s) => s.m === "close");
  if (!best) {
    const e = lookup.entries[0];
    return finish(
      "different_product",
      `*Likely fake.* NAFDAC ${no} is real, but it belongs to a different product: ${describe(e)}${e.applicant ? `, registered to ${e.applicant}` : ""}. The pack you sent says ${pack.productName ?? "something else"}.`,
    );
  }

  const e = best.e;
  if (best.m === "close") flags.push(`The name on the pack is spelt slightly differently from the register (${e.productName}). Check it carefully.`);
  if (e.status && e.status.toLowerCase() !== "active") flags.push(`The register shows this registration as ${e.status}.`);
  const regExpiry = e.registrationExpires ? new Date(e.registrationExpires) : null;
  if (regExpiry && !Number.isNaN(regExpiry.getTime()) && regExpiry.getTime() < now.getTime()) {
    flags.push(`The registration expired on ${e.registrationExpires}.`);
  }

  return finish(
    "registered_match",
    `*Registered and matches.* NAFDAC ${no} is ${describe(e)}${e.applicant ? `, registered to ${e.applicant}` : ""}${e.status ? `, status ${e.status}` : ""}.`,
  );
}

/** The message shown to the user. Always ends with the registration-only disclaimer. */
export function formatVerdict(v: Verdict, note?: string): string {
  const flags = v.flags.length ? `\n\n${v.code === "registered_match" ? "*But note:*" : "*Also:*"}\n${v.flags.map((f) => `- ${f}`).join("\n")}` : "";
  return `${v.text}${flags}${note ? `\n\n${note}` : ""}\n\n${DISCLAIMER}`;
}
