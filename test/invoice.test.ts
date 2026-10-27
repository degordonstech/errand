import { describe, expect, it } from "vitest";
import { formatMoney, invoiceTotal, lineTotal, renderInvoicePdf } from "../src/invoice/pdf.js";
import { findRepeat, normaliseInvoiceNumber } from "../src/tools/invoice.js";

describe("invoice maths", () => {
  it("totals quantity times unit price", () => {
    const items = [
      { description: "Rice", quantity: 3, unitPrice: 75000 },
      { description: "Groceries", quantity: 2, unitPrice: 12500 },
    ];
    expect(lineTotal(items[0])).toBe(225000);
    expect(invoiceTotal(items)).toBe(250000);
  });

  it("rounds to kobo", () => {
    expect(invoiceTotal([{ description: "x", quantity: 3, unitPrice: 0.1 }])).toBe(0.3);
  });

  it("formats naira amounts", () => {
    expect(formatMoney(225000)).toBe("NGN 225,000.00");
  });
});

describe("normaliseInvoiceNumber", () => {
  it.each(["INV-0007", "inv-7", "7", "0007", "invoice 7"])("reads %j as INV-0007", (s) => expect(normaliseInvoiceNumber(s)).toBe("INV-0007"));
});

describe("renderInvoicePdf", () => {
  it("produces a PDF even with characters the PDF fonts cannot draw", async () => {
    const pdf = await renderInvoicePdf({
      number: "INV-0001",
      issuedOn: new Date("2026-10-27T09:00:00Z"),
      currency: "NGN",
      seller: { name: "Gold Foods \u{1F35A}" },
      customer: { name: "Chidi \u20A6 Okafor" },
      items: Array.from({ length: 40 }, (_, i) => ({ description: `Item ${i} with a long description that needs wrapping across lines`, quantity: 1, unitPrice: 1000 })),
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });
});

describe("findRepeat", () => {
  const now = Date.parse("2026-10-27T16:02:46Z");
  const inv4 = { number: "INV-0004", customer_name: "Godwin", total: 225000, sent_at: null, created_at: "2026-10-27T16:01:22Z" };

  it("finds the unsent invoice the user is still answering questions about", () => {
    expect(findRepeat([inv4], " godwin ", 225000, now)?.number).toBe("INV-0004");
  });
  it("allows a new invoice once the first was emailed, the total differs or time has passed", () => {
    expect(findRepeat([{ ...inv4, sent_at: "2026-10-27T16:02:00Z" }], "Godwin", 225000, now)).toBeUndefined();
    expect(findRepeat([inv4], "Godwin", 150000, now)).toBeUndefined();
    expect(findRepeat([inv4], "Godwin", 225000, now + 31 * 60_000)).toBeUndefined();
  });
});
