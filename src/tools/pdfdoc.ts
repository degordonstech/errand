import { z } from "zod";
import { renderTextPdf } from "../invoice/text-pdf.js";
import { sendDocument } from "../telegram/send.js";
import { defineTool } from "./types.js";

export const makePdf = defineTool({
  name: "make_pdf",
  description:
    "Turn something the user dictated or asked for (notes, a letter, a plan, a list, minutes of a meeting) into a neat PDF and send it to them. " +
    'Tidy the text first. Use "## " for section headings and "- " for bullet points.',
  sensitive: false,
  schema: z.object({
    title: z.string().min(1).max(100),
    body: z.string().min(1).max(20_000),
  }),
  async run({ title, body }, { user }) {
    const pdf = await renderTextPdf(title, body, user.preferred_name ?? user.name ?? undefined);
    const filename = `${title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "document"}.pdf`;
    await sendDocument(user.chat_id, pdf, filename);
    return { message: `Sent "${title}" as a PDF. Do not repeat its contents.` };
  },
});
