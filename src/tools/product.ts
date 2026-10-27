import { z } from "zod";
import { db } from "../db/supabase.js";
import { lookupNafdac, normaliseNafdacNo } from "../product/greenbook.js";
import { markPack } from "../product/mark.js";
import { decide, formatVerdict, type PackReading } from "../product/verdict.js";
import { downloadFile } from "../telegram/api.js";
import { sendPhoto } from "../telegram/send.js";
import { logger } from "../log.js";
import type { TurnFile } from "./types.js";
import { defineTool } from "./types.js";

/** The model sometimes writes the word "null" for a field it could not read. */
const blank = (s: string | null | undefined) => (s && !/^(null|none|n\/?a|unknown|not visible)$/i.test(s.trim()) ? s : null);

/**
 * Sends the user's photo back with the pack outlined and the NAFDAC number boxed, so they can see
 * exactly what was checked. A second, closer reading that disagrees is pointed out. Never blocks the verdict.
 */
async function showWhatWasRead(chatId: string, files: TurnFile[] | undefined, nafdacNo: string | null): Promise<void> {
  const photo = files?.filter((f) => f.kind === "photo").at(-1);
  if (!photo || !nafdacNo) return;
  try {
    const marked = await markPack(await downloadFile(photo.fileId));
    if (!marked) return;
    const second = marked.numberRead ? normaliseNafdacNo(marked.numberRead) : null;
    const caption =
      second && second !== nafdacNo
        ? `Up close I read ${second}, not ${nafdacNo}. Check the number on the pack.`
        : `The number I checked: ${nafdacNo}`;
    await sendPhoto(chatId, marked.image, caption);
  } catch (err) {
    logger.warn({ err }, "could not mark the pack photo");
  }
}

export const checkProduct = defineTool({
  name: "check_product",
  description:
    "Check a drug or product pack against the NAFDAC Greenbook register. Read every side of the pack in the photos or video first, " +
    "then pass exactly what is printed. MyPaddy looks the number up, compares it and shows the verdict to the user. " +
    "Never guess characters you cannot read: lower the confidence instead.",
  sensitive: false,
  schema: z.object({
    product_name: z.string().max(150).nullable().describe("Brand or product name as printed."),
    active_ingredient: z.string().max(150).nullable().optional(),
    strength: z.string().max(80).nullable().optional(),
    product_type: z.enum(["drug", "herbal", "food", "drink", "cosmetic", "device", "other"]),
    nafdac_number: z.string().max(30).nullable().describe("Exactly as printed, for example 04-2467 or A4-1234. Null if none is visible."),
    nafdac_number_confidence: z.enum(["high", "medium", "low", "not_visible"]),
    batch_number: z.string().max(40).nullable().optional(),
    expiry_date: z.string().max(40).nullable().optional().describe("As printed, for example 10/2027."),
    manufacturer: z.string().max(150).nullable().optional(),
    packaging_concerns: z.array(z.string().max(200)).max(8).optional().describe("Spelling mistakes, smudged or uneven print, missing details, tampered seals."),
    where_bought: z.string().max(150).optional().describe("Where the user says they bought it, if they said."),
  }),
  async run(args, { user, files }) {
    const pack: PackReading = {
      productName: blank(args.product_name),
      activeIngredient: blank(args.active_ingredient),
      strength: blank(args.strength),
      productType: args.product_type,
      nafdacNo: blank(args.nafdac_number) ? normaliseNafdacNo(args.nafdac_number!) : null,
      nafdacConfidence: args.nafdac_number_confidence,
      batchNo: blank(args.batch_number),
      expiry: blank(args.expiry_date),
      manufacturer: blank(args.manufacturer),
      packagingConcerns: args.packaging_concerns,
    };

    // Marking the photo and looking the number up run side by side.
    const marking = showWhatWasRead(user.chat_id, files, pack.nafdacNo);
    const canLookUp = pack.nafdacNo && ["high", "medium"].includes(pack.nafdacConfidence);
    const lookup = canLookUp ? await lookupNafdac(pack.nafdacNo!) : { ok: true as const, entries: [] };
    const verdict = decide(pack, lookup);
    await marking;
    const offline = lookup.ok && "source" in lookup && lookup.source === "offline";
    const text = formatVerdict(verdict, offline ? "_The NAFDAC Greenbook could not be reached, so this used a saved copy of its entry._" : undefined);

    await db.from("product_checks").insert({
      user_id: user.id,
      product_name: pack.productName,
      nafdac_no: pack.nafdacNo,
      verdict: verdict.code,
      details: { pack: args, flags: verdict.flags, register: lookup.ok ? lookup.entries : null },
      where_bought: args.where_bought ?? null,
    });

    return {
      message: `Verdict ${verdict.code} shown to the user. Do not repeat it. You may add one short line in the user's language, but never say the product is safe to take or give medical advice.`,
      data: { verdict: verdict.code, flags: verdict.flags },
      showUser: text,
    };
  },
});
