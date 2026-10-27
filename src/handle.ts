import type OpenAI from "openai";
import { runAgent } from "./ai/agent.js";
import { systemPrompt } from "./ai/prompts.js";
import { transcribe } from "./ai/transcribe.js";
import { imagePart, pdfPart, videoParts } from "./ai/vision.js";
import { getOrCreateUser, recentMessages, saveMessage, type User } from "./db/supabase.js";
import { logger, maskPhone } from "./log.js";
import { waitingForUser } from "./jobs/queue.js";
import { classifyReply } from "./safety/gate.js";
import { gate } from "./safety/instance.js";
import { logAction } from "./tools/log.js";
import { loadMemory } from "./tools/memory.js";
import { downloadMedia } from "./whatsapp/media.js";
import { markReadAndTyping, sendText } from "./whatsapp/send.js";
import type { InboundMessage } from "./whatsapp/types.js";

type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

const HISTORY_LIMIT = 20;

interface Inbound {
  /** What the user said: text, caption or voice transcript. */
  text: string;
  /** Media for the model to look at. */
  parts: ContentPart[];
  /** Stored in history in place of the media itself. */
  label: string;
}

async function readInbound(msg: InboundMessage, memory: Record<string, string>): Promise<Inbound> {
  const caption = msg.text?.trim() ?? "";
  switch (msg.kind) {
    case "text":
      return { text: caption, parts: [], label: caption };
    case "voice": {
      const audio = await downloadMedia(msg.media!.id);
      const keywords = Object.values(memory).filter((v) => v.length <= 40);
      const transcript = await transcribe(audio.data, keywords);
      return { text: transcript, parts: [], label: transcript ? `[voice note] ${transcript}` : "[voice note]" };
    }
    case "image": {
      const img = await downloadMedia(msg.media!.id);
      return { text: caption, parts: [imagePart(img.data, img.mimeType)], label: `[photo]${caption ? ` ${caption}` : ""}` };
    }
    case "video": {
      const vid = await downloadMedia(msg.media!.id);
      return { text: caption, parts: await videoParts(vid.data), label: `[video]${caption ? ` ${caption}` : ""}` };
    }
    case "doc": {
      const file = await downloadMedia(msg.media!.id);
      const name = msg.media!.filename ?? "document";
      if (file.mimeType === "application/pdf") {
        return { text: caption, parts: [pdfPart(file.data, name)], label: `[pdf: ${name}]${caption ? ` ${caption}` : ""}` };
      }
      if (file.mimeType.startsWith("image/")) {
        return { text: caption, parts: [imagePart(file.data, file.mimeType)], label: `[photo]${caption ? ` ${caption}` : ""}` };
      }
      return { text: caption, parts: [], label: `[file: ${name}, type not supported]` };
    }
    default:
      return { text: "", parts: [], label: `[${msg.rawType ?? "unsupported"} message]` };
  }
}

async function reply(user: User, msg: InboundMessage, inbound: Inbound, memory: Record<string, string>): Promise<string> {
  if (msg.kind === "other") return "I can work with text, voice notes, photos, videos and PDFs. Send me one of those.";
  if (!inbound.text && !inbound.parts.length) {
    return msg.kind === "voice"
      ? "I could not make out that voice note. Could you try again?"
      : "I can read photos and PDFs. That file type is not one I can open yet.";
  }

  // A bare YES or NO answers the user's own waiting action, typed or spoken.
  if (!inbound.parts.length) {
    const answer = await gate.answer(user.id, inbound.text);
    if (answer) return answer;
  }

  const history = (await recentMessages(user.id, HISTORY_LIMIT, msg.id))
    .filter((m) => m.text)
    .map((m) => ({ role: m.direction === "in" ? ("user" as const) : ("assistant" as const), content: m.text! }));

  const content: string | ContentPart[] = inbound.parts.length
    ? [{ type: "text", text: inbound.text || "(no caption)" }, ...inbound.parts]
    : `${msg.kind === "voice" ? "(voice note transcript) " : ""}${inbound.text}`;

  return runAgent(
    { ctx: { user }, system: systemPrompt({ user, memory, now: new Date() }), history, content },
    {
      gate,
      logRun: (tool, args, result, ok) => logAction({ userId: user.id, tool, args, result: { value: result }, status: ok ? "done" : "failed" }),
    },
  );
}

/**
 * People often send a photo or video first and say what they want in the next message,
 * for example a video of a pack followed by a voice note. Media without a caption is held
 * briefly and joined to the user's next message.
 */
const HELD_MEDIA_MS = 10 * 60 * 1000;
const FOLLOW_UP_WAIT_MS = 6000;
const heldMedia = new Map<string, { parts: ContentPart[]; at: number }>();

async function followUpIsQueued(userKey: string): Promise<boolean> {
  for (let waited = 0; waited < FOLLOW_UP_WAIT_MS; waited += 500) {
    if (waitingForUser(userKey) > 0) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function handleMessage(msg: InboundMessage): Promise<void> {
  const started = Date.now();
  await markReadAndTyping(msg.id);
  const user = await getOrCreateUser(msg.from, msg.profileName);

  let answer: string;
  try {
    const memory = await loadMemory(user.id);
    if (msg.kind === "video") await sendText(msg.from, "On it, looking at your video...");
    const inbound = await readInbound(msg, memory);
    await saveMessage(user.id, "in", msg.kind, inbound.label, msg.id);

    const held = heldMedia.get(msg.from);
    heldMedia.delete(msg.from);
    const earlier = held && Date.now() - held.at < HELD_MEDIA_MS ? held.parts : [];

    if (inbound.parts.length && !inbound.text) {
      // Keep it for the next message too, in case the user answers a question about it.
      heldMedia.set(msg.from, { parts: [...earlier, ...inbound.parts], at: Date.now() });
      if (await followUpIsQueued(msg.from)) {
        logger.info({ from: maskPhone(msg.from), kind: msg.kind }, "media held for the next message");
        return;
      }
    }
    // A bare YES or NO answers a waiting action and must reach the gate on its own.
    if (earlier.length && !classifyReply(inbound.text)) inbound.parts = [...earlier, ...inbound.parts];

    answer = await reply(user, msg, inbound, memory);
  } catch (err) {
    logger.error({ err, from: maskPhone(msg.from), kind: msg.kind }, "handling failed");
    answer = "Something went wrong on my side. Please send that again in a moment.";
  }

  const outId = await sendText(msg.from, answer);
  await saveMessage(user.id, "out", "text", answer, outId);
  logger.info({ from: maskPhone(msg.from), kind: msg.kind, rawType: msg.rawType, ms: Date.now() - started }, "message handled");
}
