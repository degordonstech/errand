import { db } from "../db/supabase.js";
import { logger } from "../log.js";
import { fetchRetry } from "../net.js";
import { SEED_ENTRIES } from "./seed.js";

// The public Greenbook page is a server-side DataTable. Its rows come from this JSON endpoint.
const BASE = "https://greenbook.nafdac.gov.ng/";
const CACHE_DAYS = 7;

export interface RegisterEntry {
  nafdacNo: string;
  productName: string;
  ingredient: string | null;
  strength: string | null;
  form: string | null;
  category: string | null;
  applicant: string | null;
  status: string | null;
  approvalDate: string | null;
  registrationExpires: string | null;
}

/** "04 2467", "04-2467 " and "a4-1234" become "04-2467" and "A4-1234". */
export function normaliseNafdacNo(input: string): string {
  return input
    .toUpperCase()
    .replace(/NAFDAC|REG\.?|NO\.?|NRN|:/g, "")
    .replace(/[\s‐-―_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .trim();
}

/** Greenbook product names carry stray markers such as "**" and "#". */
const cleanName = (s: string) => s.replace(/[*#$]+/g, "").replace(/\s+/g, " ").trim();

function toEntry(p: any): RegisterEntry {
  return {
    nafdacNo: String(p.NAFDAC ?? "").trim(),
    productName: cleanName(String(p.product_name ?? "")),
    ingredient: p.ingredient_name ?? p.ingredient?.ingredient_name ?? null,
    strength: p.strength ?? null,
    form: p.form_name ?? p.form?.name ?? null,
    category: p.category_name ?? p.product_category?.name ?? null,
    applicant: p.applicant_name ?? p.applicant?.name ?? null,
    status: p.status ?? null,
    approvalDate: p.approval_date ?? null,
    registrationExpires: p.expiry_date ?? null,
  };
}

async function fetchFromGreenbook(nafdacNo: string): Promise<RegisterEntry[]> {
  const params = new URLSearchParams({ draw: "1", start: "0", length: "25", "search[value]": nafdacNo, "search[regex]": "false" });
  const res = await fetchRetry(`${BASE}?${params}`, {
    headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; MyPaddy/0.1)" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Greenbook HTTP ${res.status}`);
  const body = (await res.json()) as { data?: unknown[] };
  // The search is free text, so keep exact number matches only.
  return (body.data ?? []).map(toEntry).filter((e) => normaliseNafdacNo(e.nafdacNo) === nafdacNo);
}

/** "live" is a fresh answer, "cache" a recent one, "offline" a saved copy used because the register could not be reached. */
export type LookupSource = "live" | "cache" | "offline";
export type LookupResult = { ok: true; entries: RegisterEntry[]; source: LookupSource } | { ok: false; error: string };

/** Looks a number up, using the cache when it is fresh. An empty list means "not on the register". */
export async function lookupNafdac(raw: string): Promise<LookupResult> {
  const nafdacNo = normaliseNafdacNo(raw);
  const { data: cached } = await db.from("nafdac_cache").select("register_data, fetched_at").eq("nafdac_no", nafdacNo).maybeSingle();
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < CACHE_DAYS * 86_400_000) {
    return { ok: true, entries: cached.register_data as RegisterEntry[], source: "cache" };
  }

  try {
    const entries = await fetchFromGreenbook(nafdacNo);
    await db.from("nafdac_cache").upsert({ nafdac_no: nafdacNo, register_data: entries, fetched_at: new Date().toISOString() });
    return { ok: true, entries, source: "live" };
  } catch (err) {
    logger.warn({ err, nafdacNo }, "Greenbook lookup failed");
    // A saved answer is better than none when the site is down. A missing number is never
    // reported from saved data: "not found" needs the live register.
    const saved = (cached?.register_data as RegisterEntry[] | undefined) ?? [];
    if (saved.length) return { ok: true, entries: saved, source: "offline" };
    if (SEED_ENTRIES[nafdacNo]) return { ok: true, entries: SEED_ENTRIES[nafdacNo], source: "offline" };
    return { ok: false, error: (err as Error).message };
  }
}
