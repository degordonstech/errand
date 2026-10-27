import type OpenAI from "openai";
import { runAgent } from "./ai/agent.js";
import { systemPrompt } from "./ai/prompts.js";
import { transcribe } from "./ai/transcribe.js";
import { imagePart, pdfPart, videoParts } from "./ai/vision.js";
import { config } from "./config.js";
import { countInboundSince, getOrCreateUser, recentMessages, saveMessage, type User } from "./db/supabase.js";
import { logger, maskId } from "./log.js";
import { waitingForUser } from "./jobs/queue.js";
import { classifyReply, STALE_BUTTON, startOfLagosDay } from "./safety/gate.js";
import { gate } from "./safety/instance.js";
import { logAction } from "./tools/log.js";
import { loadMemory } from "./tools/memory.js";
import { downloadFile } from "./telegram/api.js";
import { APPROVAL_PROMPT, keepTyping, parseApprovalButton, sendApproval, sendText, settleButtons } from "./telegram/send.js";
import type { InboundMedia, InboundMessage } from "./telegram/types.js";

type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

const HISTORY_LIMIT = 20;
/** Telegram lets bots download files up to 20 MB. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

const WELCOME =
  "Hi, I'm *MyPaddy*. I remember things for you, remind you before it's too late, check if things are fake, and handle small tasks like invoices and replies to letters.\n\n" +
  "Talk to me like a friend: type, send a voice note, a photo, a video or a PDF. Nothing is ever sent for you without your YES.\n\n" +
  'Try: "What can you do?"';

const TOO_LARGE = "That file is too big for me to open (the limit is 20 MB). Could you send a shorter video or a smaller file?";

class FileTooLarge extends Error {}

interface Inbound {
  /** What the user said: text, caption or voice transcript. */
  text: string;
  /** Media for the model to look at. */
  parts: ContentPart[];
  /** Stored in history in place of the media itself. */
  label: string;
}

async function download(media: InboundMedia): Promise<Buffer> {
  if (media.size && media.size > MAX_DOWNLOAD_BYTES) throw new FileTooLarge();
  return downloadFile(media.id);
}

async function readInbound(msg: InboundMessage, memory: Record<string, string>): Promise<Inbound> {
  const caption = msg.text?.trim() ?? "";
  const media = msg.media;
  switch (msg.kind) {
    case "text":
      return { text: caption, parts: [], label: caption };
    case "voice": {
      const audio = await download(media!);
      const keywords = Object.values(memory).filter((v) => v.length <= 40);
      const transcript = await transcribe(audio, keywords);
      return { text: transcript, parts: [], label: transcript ? `[voice note] ${transcript}` : "[voice note]" };
    }
    case "image": {
      const img = await download(media!);
      return { text: caption, parts: [imagePart(img, media!.mimeType)], label: `[photo]${caption ? ` ${caption}` : ""}` };
    }
    case "video": {
      const vid = await download(media!);
      return { text: caption, parts: await videoParts(vid), label: `[video]${caption ? ` ${caption}` : ""}` };
    }
    case "doc": {
      const name = media!.filename ?? "document";
      if (media!.mimeType === "application/pdf") {
        const file = await download(media!);
        return { text: caption, parts: [pdfPart(file, name)], label: `[pdf: ${name}]${caption ? ` ${caption}` : ""}` };
      }
      if (media!.mimeType.startsWith("image/")) {
        const file = await download(media!);
        return { text: caption, parts: [imagePart(file, media!.mimeType)], label: `[photo]${caption ? ` ${caption}` : ""}` };
      }
      return { text: caption, parts: [], label: `[file: ${name}, type not supported]` };
    }
    default:
      return { text: "", parts: [], label: `[${msg.rawType ?? "unsupported"} message]` };
  }
}

async function reply(user: User, msg: InboundMessage, inbound: Inbound, memory: Record<string, string>, earlier: ContentPart[]): Promise<string> {
  if (msg.kind === "other") return "I can work with text, voice notes, photos, videos and PDFs. Send me one of those.";
  if (!inbound.text && !inbound.parts.length && !earlier.length) {
    return msg.kind === "voice"
      ? "I could not make out that voice note. Could you try again?"
      : "I can read photos and PDFs. That file type is not one I can open yet.";
  }
  if (/^\/start\b/.test(inbound.text)) return WELCOME;

  // A bare YES or NO answers the user's own waiting action, typed or spoken.
  if (!inbound.parts.length) {
    const answer = await gate.answer(user.id, inbound.text);
    if (answer) return answer;
  }
  // Nothing was waiting, so a "yes" is about the media they just sent ("Should I check it?" "Yes").
  inbound.parts = [...earlier, ...inbound.parts];

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

/** An approval request goes out with Yes and No buttons tied to the waiting action. */
async function sendAnswer(user: User, answer: string): Promise<string | undefined> {
  if (answer.endsWith(APPROVAL_PROMPT)) {
    const action = await gate.waiting(user.id).catch(() => null);
    if (action) return sendApproval(user.chat_id, answer.slice(0, -APPROVAL_PROMPT.length).trim(), action.id);
  }
  return sendText(user.chat_id, answer);
}

/** A tapped Yes or No button. Taps never count towards the daily limit. */
async function handleTap(user: User, msg: InboundMessage): Promise<void> {
  await settleButtons(msg.from, msg.callback!);
  const tapped = parseApprovalButton(msg.buttonId);
  if (!tapped) return;
  await saveMessage(user.id, "in", "text", tapped.decision, msg.id);
  let answer: string;
  try {
    answer = (await gate.answer(user.id, tapped.decision, tapped.actionId)) ?? STALE_BUTTON;
  } catch (err) {
    logger.error({ err, from: maskId(msg.from) }, "button handling failed");
    answer = "Something went wrong on my side. Nothing was sent. Please try again in a moment.";
  }
  const outId = await sendText(user.chat_id, answer);
  await saveMessage(user.id, "out", "text", answer, outId);
}

/** True when the user has used up today's messages. Tells them once, then stays quiet. */
async function overDailyLimit(user: User, msg: InboundMessage): Promise<boolean> {
  const used = await countInboundSince(user.id, startOfLagosDay(new Date())).catch(() => 0);
  if (used < config.DAILY_MESSAGE_LIMIT) return false;
  await saveMessage(user.id, "in", msg.kind, "[over daily limit]", msg.id);
  if (used === config.DAILY_MESSAGE_LIMIT) {
    await sendText(user.chat_id, "That's all I can do for today. Your daily limit resets at midnight, Lagos time. Talk tomorrow!");
  }
  logger.info({ from: maskId(msg.from) }, "daily message limit reached");
  return true;
}

export async function handleMessage(msg: InboundMessage): Promise<void> {
  const started = Date.now();
  const user = await getOrCreateUser(msg.from, msg.profileName);
  if (msg.callback) return handleTap(user, msg);
  if (await overDailyLimit(user, msg)) return;

  const stopTyping = keepTyping(msg.from);
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
        logger.info({ from: maskId(msg.from), kind: msg.kind }, "media held for the next message");
        return;
      }
    }
    // A bare YES or NO must reach the gate on its own first; reply() adds the held media
    // back if no action was waiting.
    const isAnswer = Boolean(classifyReply(inbound.text));
    if (!isAnswer) inbound.parts = [...earlier, ...inbound.parts];

    answer = await reply(user, msg, inbound, memory, isAnswer ? earlier : []);
  } catch (err) {
    if (err instanceof FileTooLarge) answer = TOO_LARGE;
    else {
      logger.error({ err, from: maskId(msg.from), kind: msg.kind }, "handling failed");
      answer = "Something went wrong on my side. Please send that again in a moment.";
    }
  } finally {
    stopTyping();
  }

  const outId = await sendAnswer(user, answer);
  await saveMessage(user.id, "out", "text", answer, outId);
  logger.info({ from: maskId(msg.from), kind: msg.kind, rawType: msg.rawType, ms: Date.now() - started }, "message handled");
}
