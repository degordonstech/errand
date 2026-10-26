import { transcribe } from "./ai/transcribe.js";
import { askAboutMedia, imagePart, pdfPart, videoParts } from "./ai/vision.js";
import { getOrCreateUser, saveMessage } from "./db/supabase.js";
import { logger, maskPhone } from "./log.js";
import { downloadMedia } from "./whatsapp/media.js";
import { markReadAndTyping, sendText } from "./whatsapp/send.js";
import type { InboundMessage } from "./whatsapp/types.js";

const DESCRIBE = "Describe what is in this in two or three short sentences. Read out any important text.";

/** Handles one inbound message end to end. The agent loop replaces the reply logic here later. */
export async function handleMessage(msg: InboundMessage): Promise<void> {
  const started = Date.now();
  await markReadAndTyping(msg.id);
  const user = await getOrCreateUser(msg.from, msg.profileName);

  let incomingText = msg.text;
  let reply: string;

  try {
    switch (msg.kind) {
      case "text":
        reply = `You said: ${msg.text ?? ""}`;
        break;
      case "voice": {
        const audio = await downloadMedia(msg.media!.id);
        logger.debug({ mime: audio.mimeType, bytes: audio.data.length }, "voice note downloaded");
        incomingText = await transcribe(audio.data);
        reply = incomingText ? `I heard: "${incomingText}"` : "I could not make out that voice note. Could you try again?";
        break;
      }
      case "image": {
        const img = await downloadMedia(msg.media!.id);
        reply = await askAboutMedia(DESCRIBE, [imagePart(img.data, img.mimeType)]);
        break;
      }
      case "video": {
        const vid = await downloadMedia(msg.media!.id);
        reply = await askAboutMedia(DESCRIBE, await videoParts(vid.data));
        break;
      }
      case "doc": {
        const file = await downloadMedia(msg.media!.id);
        if (file.mimeType === "application/pdf") {
          reply = await askAboutMedia(DESCRIBE, [pdfPart(file.data, msg.media!.filename)]);
        } else if (file.mimeType.startsWith("image/")) {
          reply = await askAboutMedia(DESCRIBE, [imagePart(file.data, file.mimeType)]);
        } else {
          reply = "I can read photos and PDFs. That file type is not one I can open yet.";
        }
        break;
      }
      default:
        reply = "I can work with text, voice notes, photos, videos and PDFs. Send me one of those.";
    }
  } catch (err) {
    logger.error({ err, from: maskPhone(msg.from), kind: msg.kind }, "handling failed");
    reply = "Something went wrong on my side. Please send that again in a moment.";
  }

  await saveMessage(user.id, "in", msg.kind, incomingText, msg.id);
  const outId = await sendText(msg.from, reply || "I could not read that one. Could you send it again?");
  await saveMessage(user.id, "out", "text", reply, outId);
  logger.info({ from: maskPhone(msg.from), kind: msg.kind, rawType: msg.rawType, ms: Date.now() - started }, "message handled");
}
