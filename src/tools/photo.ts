import { toFile } from "openai";
import { z } from "zod";
import { meta, retryModelNotFound } from "../ai/client.js";
import { scaleImage } from "../media/ffmpeg.js";
import { downloadFile } from "../telegram/api.js";
import { sendPhoto, sendText } from "../telegram/send.js";
import { defineTool } from "./types.js";

const MUSE_IMAGE = "muse-image-1.0";

export const makeProductPhoto = defineTool({
  name: "make_product_photo",
  description:
    "Turn the photo the user just sent of something they sell into a clean product photo for WhatsApp Status, Instagram or a catalogue, " +
    "using Muse Image. The product and its labels stay exactly as they are; only the background and lighting change.",
  sensitive: false,
  schema: z.object({
    background: z
      .string()
      .max(200)
      .optional()
      .describe('What they asked for, for example "plain white", "on a wooden table", "outdoor market feel". Defaults to a white studio background.'),
  }),
  async run({ background }, { user, files }) {
    const photo = files?.filter((f) => f.kind === "photo" || f.mimeType.startsWith("image/")).at(-1);
    if (!photo) throw new Error("There is no photo in this message. Ask the user to send a photo of the product.");
    await sendText(user.chat_id, "Working on your photo. This takes about 30 seconds...");

    const original = await scaleImage(await downloadFile(photo.fileId), 1600);
    const setting = background?.trim() || "a plain soft white studio background";
    const res = await retryModelNotFound(async () =>
      meta.images.edit({
        model: MUSE_IMAGE,
        image: await toFile(original, "product.jpg", { type: "image/jpeg" }),
        prompt:
          `Turn this into a clean product photo for selling online. Keep the product exactly as it is, with all its text, labels and colours unchanged. ` +
          `Place it on ${setting}, with soft even lighting and a gentle natural shadow. Do not add any text, logos or other products.`,
      }, { timeout: 150_000, maxRetries: 1 }),
    );
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new Error("Muse Image returned no picture.");
    // Muse Image returns WebP; JPEG shows everywhere, including WhatsApp Status.
    const jpeg = await scaleImage(Buffer.from(b64, "base64"), 1600);
    await sendPhoto(user.chat_id, jpeg, "Here's your product photo. Ready for your Status or catalogue.");
    return { message: "The new product photo has been sent to the user. Do not describe it. You may offer a different background in one short line." };
  },
});

/** Quotes are what Muse Image copies letter for letter, so anything inside them is kept short and plain. */
const quoteSafe = (s: string) => s.replace(/["\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

export const makeCard = defineTool({
  name: "make_card",
  description:
    "Make a greeting card image with Muse Image: birthday, congratulations, graduation, wedding, thank you, get well or any celebration. " +
    "Use it when the user asks for a card, or says yes to a birthday reminder's offer of one.",
  sensitive: false,
  schema: z.object({
    headline: z.string().min(1).max(60).describe('The big words on the card, for example "Happy Birthday, Tobi!".'),
    from: z.string().max(40).optional().describe("Who it is from, usually the user's name."),
    style: z
      .string()
      .max(200)
      .optional()
      .describe('Look and feel, for example "green and gold balloons", "elegant floral", "Ankara pattern", "football theme". Pick something fitting if not given.'),
  }),
  async run({ headline, from, style }, { user }) {
    await sendText(user.chat_id, "Making your card...");
    const signature = from ? ` with a smaller line underneath reading exactly "From ${quoteSafe(from)}"` : "";
    const res = await retryModelNotFound(() =>
      meta.images.generate(
        {
          model: MUSE_IMAGE,
          prompt:
            `A warm, stylish greeting card. Large clear lettering that reads exactly "${quoteSafe(headline)}"${signature}. ` +
            `${style?.trim() || "Festive and joyful"}, modern illustration, plenty of space around the text, every letter spelled correctly. No other words.`,
        },
        { timeout: 150_000, maxRetries: 1 },
      ),
    );
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new Error("Muse Image returned no picture.");
    await sendPhoto(user.chat_id, await scaleImage(Buffer.from(b64, "base64"), 1600));
    return { message: "The card has been sent. Now offer a short message to go with it, in the user's voice, ready to copy." };
  },
});
