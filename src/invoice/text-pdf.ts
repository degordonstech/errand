import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { formatDate, safe, wrap } from "./pdf.js";

const W = 595.28; // A4
const H = 841.89;
const M = 56;
const INK = rgb(0.13, 0.15, 0.18);
const MUTED = rgb(0.42, 0.45, 0.5);

/**
 * A neat one-column document from plain text: a title, the date, then paragraphs.
 * Lines starting with "- " become bullets and "## " starts a section heading.
 */
export async function renderTextPdf(title: string, body: string, author?: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(safe(title));
  if (author) doc.setAuthor(safe(author));
  doc.setCreator("MyPaddy");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([W, H]);
  let y = H - M;
  const ensure = (needed: number) => {
    if (y - needed < M) {
      page = doc.addPage([W, H]);
      y = H - M;
    }
  };
  const write = (text: string, opts: { size: number; font: typeof regular; color?: typeof INK; indent?: number; gap: number }) => {
    for (const line of wrap(text, opts.font, opts.size, W - 2 * M - (opts.indent ?? 0))) {
      ensure(opts.size + 4);
      page.drawText(line, { x: M + (opts.indent ?? 0), y, size: opts.size, font: opts.font, color: opts.color ?? INK });
      y -= opts.size + 5;
    }
    y -= opts.gap;
  };

  write(title, { size: 20, font: bold, gap: 4 });
  write(`${formatDate(new Date())}${author ? `  |  ${author}` : ""}`, { size: 9, font: regular, color: MUTED, gap: 16 });

  for (const raw of body.split(/\n/)) {
    const line = raw.trim();
    if (!line) {
      y -= 6;
      continue;
    }
    if (line.startsWith("## ")) {
      y -= 6;
      write(line.slice(3), { size: 13, font: bold, gap: 4 });
    } else if (/^[-*] /.test(line)) {
      ensure(15);
      page.drawText("-", { x: M + 4, y, size: 11, font: regular, color: INK });
      write(line.slice(2), { size: 11, font: regular, indent: 16, gap: 2 });
    } else write(line, { size: 11, font: regular, gap: 6 });
  }
  return Buffer.from(await doc.save());
}
