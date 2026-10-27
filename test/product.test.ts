import { describe, expect, it } from "vitest";
import { normaliseNafdacNo, type RegisterEntry } from "../src/product/greenbook.js";
import { decide, DISCLAIMER, formatVerdict, nameMatch, parseExpiry, type PackReading } from "../src/product/verdict.js";

const NOW = new Date("2026-10-28T10:00:00Z");

const zentel: RegisterEntry = {
  nafdacNo: "04-2467",
  productName: "Zentel Suspension",
  ingredient: "Albendazole",
  strength: "100 mg/5 mL",
  form: "Suspension",
  category: "Drugs",
  applicant: "GlaxoSmithKline Consumer Nigeria PLC (GSK)",
  status: "Active",
  approvalDate: "2023-07-06",
  registrationExpires: "2028-07-05",
};

const pack = (over: Partial<PackReading> = {}): PackReading => ({
  productName: "ZENTEL",
  activeIngredient: "Albendazole",
  strength: "100 mg/5 ml",
  productType: "drug",
  nafdacNo: "04-2467",
  nafdacConfidence: "high",
  batchNo: "54424007",
  expiry: "10/2027",
  manufacturer: "Panacea Biotec Pharma Ltd",
  packagingConcerns: [],
  ...over,
});

const found = (...entries: RegisterEntry[]) => ({ ok: true as const, entries });

describe("normaliseNafdacNo", () => {
  it.each([
    ["04-2467", "04-2467"],
    ["04 2467", "04-2467"],
    ["NAFDAC Reg. No.: 04-2467", "04-2467"],
    ["a4-1234", "A4-1234"],
    ["A4–1234", "A4-1234"],
  ])("%j -> %j", (input, out) => expect(normaliseNafdacNo(input)).toBe(out));
});

describe("parseExpiry", () => {
  it("treats month and year as the end of that month", () => {
    expect(parseExpiry("10/2027")?.toISOString()).toBe("2027-10-31T23:59:59.000Z");
  });
  it.each(["EXP 10/2027", "OCT 2027", "Oct.2027", "2027-10", "10-27"])("reads %j as October 2027", (s) => {
    expect(parseExpiry(s)?.getUTCMonth()).toBe(9);
    expect(parseExpiry(s)?.getUTCFullYear()).toBe(2027);
  });
  it("reads a full date", () => {
    expect(parseExpiry("31/03/2025")?.toISOString().slice(0, 10)).toBe("2025-03-31");
  });
  it("returns null for nonsense", () => {
    expect(parseExpiry("see crimp")).toBeNull();
    expect(parseExpiry(null)).toBeNull();
  });
});

describe("nameMatch", () => {
  it("matches the brand even with form words around it", () => expect(nameMatch(pack(), zentel)).toBe("exact"));
  it("matches on the active ingredient", () => expect(nameMatch(pack({ productName: "Albenza" }), zentel)).toBe("exact"));
  it("spots a near spelling", () => expect(nameMatch(pack({ productName: "Zentell Suspension", activeIngredient: null }), { ...zentel, ingredient: null })).toBe("close"));
  it("finds no match for an unrelated product", () =>
    expect(nameMatch(pack({ productName: "Panadol Extra", activeIngredient: "Paracetamol" }), zentel)).toBe("none"));
});

describe("decide", () => {
  it("1. registered and matches", () => {
    const v = decide(pack(), found(zentel), NOW);
    expect(v.code).toBe("registered_match");
    expect(v.text).toContain("Zentel Suspension (Albendazole 100 mg/5 mL)");
    expect(v.flags).toEqual([]);
  });

  it("2. real number on a different product is likely fake", () => {
    const v = decide(pack({ productName: "Panadol Extra", activeIngredient: "Paracetamol" }), found(zentel), NOW);
    expect(v.code).toBe("different_product");
    expect(v.text).toMatch(/Likely fake/);
    expect(v.text).toContain("Zentel Suspension");
  });

  it("3. number not on the register", () => {
    expect(decide(pack({ nafdacNo: "A4-9999" }), found(), NOW).code).toBe("not_found");
  });

  it("4. unclear number asks for a clearer shot and does not judge", () => {
    const v = decide(pack({ nafdacConfidence: "low" }), found(), NOW);
    expect(v.code).toBe("unreadable");
    expect(v.text).toMatch(/clearer|sharp/);
  });

  it("flags a missing NAFDAC number without extra noise", () => {
    const v = decide(pack({ nafdacNo: null, nafdacConfidence: "not_visible", batchNo: null, expiry: null }), found(), NOW);
    expect(v.code).toBe("no_number");
    expect(v.flags).toEqual([]);
  });

  it("notes a missing batch number on a checked pack", () => {
    expect(decide(pack({ batchNo: null }), found(zentel), NOW).flags).toContain("No batch number found on the pack.");
  });

  it("does not call food fake just because the Greenbook does not list food", () => {
    expect(decide(pack({ productType: "food", nafdacNo: "A1-1234" }), found(), NOW).code).toBe("not_covered");
  });

  it("says so when the register cannot be reached", () => {
    expect(decide(pack(), { ok: false }, NOW).code).toBe("lookup_failed");
  });

  it("flags an expired pack even when registered", () => {
    const v = decide(pack({ expiry: "03/2025" }), found(zentel), NOW);
    expect(v.code).toBe("registered_match");
    expect(v.flags.join(" ")).toMatch(/Expired/);
  });

  it("flags an inactive or lapsed registration", () => {
    const v = decide(pack(), found({ ...zentel, status: "Inactive", registrationExpires: "2024-01-01" }), NOW);
    expect(v.flags.join(" ")).toMatch(/Inactive/);
    expect(v.flags.join(" ")).toMatch(/registration expired/);
  });

  it("passes on packaging concerns the reader found", () => {
    const v = decide(pack({ packagingConcerns: ["Manufacturer spelt 'Glaxo Smithklien'"] }), found(zentel), NOW);
    expect(v.flags).toContain("Packaging: Manufacturer spelt 'Glaxo Smithklien'");
  });
});

describe("formatVerdict", () => {
  it("always ends with the registration-only disclaimer and never says safe", () => {
    for (const p of [pack(), pack({ nafdacNo: "A4-9999" }), pack({ nafdacConfidence: "low" }), pack({ productType: "food", nafdacNo: "A1-1" })]) {
      const text = formatVerdict(decide(p, found(...(p.nafdacNo === "04-2467" ? [zentel] : [])), NOW));
      expect(text.endsWith(DISCLAIMER)).toBe(true);
      expect(text.toLowerCase()).not.toMatch(/safe to (take|use)/);
    }
  });
});
