import { describe, expect, it } from "vitest";
import { formatMoney, invoiceTotal, lineTotal, renderInvoicePdf } from "../src/invoice/pdf.js";
import { normaliseInvoiceNumber } from "../src/tools/invoice.js";

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
