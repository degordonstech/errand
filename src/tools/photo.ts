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

/** Words in quotes are what Muse Image copies letter for letter, so they are kept plain and short. */
const quoteSafe = (s: string, max: number) => s.replace(/["\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export interface CardDesign {
  headline: string;
  quote: string;
  from?: string;
  theme?: string;
  withPhoto: boolean;
}

/** The brief for Muse Image: a printed stationery card, laid out top to bottom, every word given exactly. */
export function cardPrompt(d: CardDesign): string {
  const lines = [
    `Design a beautiful, premium printed greeting card, portrait orientation, like a high-end stationery card${d.withPhoto ? ", using the photo provided" : ""}.`,
    "Layout from top to bottom:",
    `- A headline in elegant large decorative lettering that reads exactly "${quoteSafe(d.headline, 60)}".`,
    d.withPhoto
      ? "- The photo, unchanged, in an elegant rounded frame with a thin gold border."
      : "- A decorative centrepiece that suits the occasion, such as a cake, flowers or a trophy.",
    `- A short quote in a refined serif font, inside a soft panel with a thin frame, that reads exactly "${quoteSafe(d.quote, 160)}".`,
    ...(d.from ? [`- At the bottom, a handwritten-style signature that reads exactly "${quoteSafe(d.from, 40)}".`] : []),
    `Look: ${d.theme?.trim() || "emerald green, cream and gold, with gold-foil accents, balloons and confetti"}. Rich paper texture, soft shadows, balanced composition with generous margins.`,
    "Every word must be spelled exactly as given. No other text anywhere.",
  ];
  return lines.join("\n");
}

export const makeCard = defineTool({
  name: "make_card",
  description:
    "Make a beautiful greeting card image with Muse Image: birthday, congratulations, graduation, wedding, thank you, get well or any celebration. " +
    "Write a short heartfelt quote for it that fits the person. Use it when the user asks for a card, or says yes to a birthday reminder's offer.",
  sensitive: false,
  schema: z.object({
    headline: z.string().min(1).max(60).describe('The big words, for example "Happy Birthday, Tobi!".'),
    quote: z
      .string()
      .min(1)
      .max(160)
      .describe("A short warm wish or quote for the inside, one or two sentences, personal to what you know about them. In English unless they asked otherwise."),
    from: z.string().max(40).optional().describe('The signature, for example "With love, Godwin".'),
    theme: z
      .string()
      .max(200)
      .optional()
      .describe('Colours and decoration, for example "pink and rose gold with flowers", "Ankara pattern", "football, Arsenal red". Pick something fitting if not given.'),
    use_photo: z.boolean().optional().describe("True when the user sent a photo of the person for the card."),
  }),
  async run({ headline, quote, from, theme, use_photo }, { user, files }) {
    const photo = use_photo ? files?.filter((f) => f.kind === "photo" || f.mimeType.startsWith("image/")).at(-1) : undefined;
    if (use_photo && !photo) throw new Error("There is no photo to put on the card. Ask the user to send one, or make it without a photo.");
    await sendText(user.chat_id, photo ? "Making your card with the photo. About 30 seconds..." : "Making your card...");

    const prompt = cardPrompt({ headline, quote, from, theme, withPhoto: Boolean(photo) });
    const options = { timeout: 150_000, maxRetries: 1 };
    const res = await retryModelNotFound(async () =>
      photo
        ? meta.images.edit(
            { model: MUSE_IMAGE, size: "1024x1536", prompt, image: await toFile(await scaleImage(await downloadFile(photo.fileId), 1600), "photo.jpg", { type: "image/jpeg" }) },
            options,
          )
        : meta.images.generate({ model: MUSE_IMAGE, size: "1024x1536", prompt }, options),
    );
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new Error("Muse Image returned no picture.");
    await sendPhoto(user.chat_id, await scaleImage(Buffer.from(b64, "base64"), 1600));
    return {
      message:
        "The card has been sent. Do not describe it. Give a short warm message to go with it, in the user's voice, ready to copy, and offer to change the colours or add a photo.",
    };
  },
});
