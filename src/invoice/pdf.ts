import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

export interface InvoiceItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface InvoiceData {
  number: string;
  issuedOn: Date;
  dueOn?: Date | null;
  currency: string;
  seller: { name: string; address?: string; phone?: string; email?: string };
  customer: { name: string; email?: string | null };
  items: InvoiceItem[];
  payment?: { bankName?: string; accountNumber?: string; accountName?: string };
  notes?: string;
}

export const lineTotal = (i: InvoiceItem) => Math.round(i.quantity * i.unitPrice * 100) / 100;
export const invoiceTotal = (items: InvoiceItem[]) => Math.round(items.reduce((s, i) => s + lineTotal(i), 0) * 100) / 100;

/** "NGN 225,000.00". The standard PDF fonts cannot draw the naira sign, so the code is spelled out. */
export function formatMoney(amount: number, currency = "NGN"): string {
  return `${currency} ${amount.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const formatDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos" });

const INK = rgb(0.13, 0.15, 0.18);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.87, 0.9);
const ACCENT = rgb(0.05, 0.4, 0.3);

/** Strips characters the WinAnsi-encoded standard fonts cannot draw, so odd input never crashes rendering. */
const safe = (s: string) => s.replace(/[^\x20-\x7E -ÿ]/g, "").trim();

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of safe(text).split(/\n/)) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

export async function renderInvoicePdf(inv: InvoiceData): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${inv.number}`);
  doc.setAuthor(safe(inv.seller.name));
  doc.setCreator("MyPaddy");

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const M = 50;
  let page: PDFPage = doc.addPage([595.28, 841.89]); // A4
  const W = page.getWidth();
  let y = page.getHeight() - M;

  const text = (s: string, x: number, size = 10, font = regular, color = INK) => page.drawText(safe(s), { x, y, size, font, color });
  const right = (s: string, xRight: number, size = 10, font = regular, color = INK) =>
    page.drawText(safe(s), { x: xRight - font.widthOfTextAtSize(safe(s), size), y, size, font, color });
  const newPageIfNeeded = (needed: number) => {
    if (y - needed < M + 40) {
      page = doc.addPage([595.28, 841.89]);
      y = page.getHeight() - M;
    }
  };

  // Header: seller on the left, INVOICE on the right.
  text(inv.seller.name, M, 18, bold);
  right("INVOICE", W - M, 22, bold, ACCENT);
  y -= 18;
  for (const line of [inv.seller.address, inv.seller.phone, inv.seller.email].filter(Boolean) as string[]) {
    for (const l of wrap(line, regular, 9, 250)) {
      text(l, M, 9, regular, MUTED);
      y -= 12;
    }
  }

  // Invoice meta block.
  let metaY = page.getHeight() - M - 30;
  const meta: [string, string][] = [
    ["Invoice no.", inv.number],
    ["Date", formatDate(inv.issuedOn)],
    ...(inv.dueOn ? ([["Due", formatDate(inv.dueOn)]] as [string, string][]) : []),
  ];
  for (const [k, v] of meta) {
    page.drawText(k, { x: W - M - 190, y: metaY, size: 9, font: regular, color: MUTED });
    page.drawText(safe(v), { x: W - M - bold.widthOfTextAtSize(safe(v), 10), y: metaY, size: 10, font: bold, color: INK });
    metaY -= 15;
  }

  y = Math.min(y, metaY) - 25;

  // Bill to.
  text("BILL TO", M, 8, bold, MUTED);
  y -= 14;
  text(inv.customer.name, M, 11, bold);
  y -= 13;
  if (inv.customer.email) {
    text(inv.customer.email, M, 9, regular, MUTED);
    y -= 13;
  }
  y -= 18;

  // Items table.
  // x of the left edge for description, right edges for the number columns.
  const cols = { desc: M + 8, qty: W - M - 250, unit: W - M - 135, amount: W - M - 8 };
  const header = () => {
    page.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: 22, color: rgb(0.95, 0.96, 0.97) });
    text("Description", cols.desc, 9, bold, MUTED);
    right("Qty", cols.qty, 9, bold, MUTED);
    right("Unit price", cols.unit, 9, bold, MUTED);
    right("Amount", cols.amount, 9, bold, MUTED);
    y -= 26;
  };
  header();

  for (const item of inv.items) {
    const lines = wrap(item.description, regular, 10, cols.qty - cols.desc - 50);
    newPageIfNeeded(lines.length * 13 + 12);
    text(lines[0], cols.desc);
    right(String(item.quantity), cols.qty);
    right(formatMoney(item.unitPrice, inv.currency), cols.unit);
    right(formatMoney(lineTotal(item), inv.currency), cols.amount);
    for (const l of lines.slice(1)) {
      y -= 13;
      text(l, cols.desc);
    }
    y -= 10;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: RULE });
    y -= 16;
  }

  // Total.
  newPageIfNeeded(60);
  y -= 4;
  right("Total", cols.unit, 11, bold);
  right(formatMoney(invoiceTotal(inv.items), inv.currency), cols.amount, 13, bold, ACCENT);
  y -= 40;

  // Payment details and notes.
  const pay = inv.payment ?? {};
  const payLines = [
    pay.bankName && `Bank: ${pay.bankName}`,
    pay.accountNumber && `Account number: ${pay.accountNumber}`,
    pay.accountName && `Account name: ${pay.accountName}`,
  ].filter(Boolean) as string[];
  if (payLines.length) {
    newPageIfNeeded(20 + payLines.length * 13);
    text("PAYMENT DETAILS", M, 8, bold, MUTED);
    y -= 14;
    for (const l of payLines) {
      text(l, M, 10);
      y -= 13;
    }
    y -= 12;
  }
  if (inv.notes) {
    const lines = wrap(inv.notes, regular, 10, W - 2 * M);
    newPageIfNeeded(20 + lines.length * 13);
    text("NOTES", M, 8, bold, MUTED);
    y -= 14;
    for (const l of lines) {
      text(l, M, 10);
      y -= 13;
    }
  }

  for (const p of doc.getPages()) {
    p.drawText("Thank you for your business.", { x: M, y: M - 10, size: 9, font: regular, color: MUTED });
  }

  return Buffer.from(await doc.save());
}
