import type OpenAI from "openai";
import { runAgent } from "./ai/agent.js";
import { systemPrompt } from "./ai/prompts.js";
import { transcribe } from "./ai/transcribe.js";
import { imagePart, pdfPart, videoParts } from "./ai/vision.js";
import { config } from "./config.js";
import { countInboundSince, db, getOrCreateUser, recentMessages, saveMessage, type User } from "./db/supabase.js";
import { logger, maskId } from "./log.js";
import { waitingForUser } from "./jobs/queue.js";
import { classifyReply, STALE_BUTTON, startOfLagosDay } from "./safety/gate.js";
import { gate } from "./safety/instance.js";
import { logAction } from "./tools/log.js";
import { loadMemory } from "./tools/memory.js";
import { downloadFile } from "./telegram/api.js";
import { isDemoCommand, isOwner, runDemo } from "./demo.js";
import { handleOnboardingTap, handleOnboardingText, isMenuRequest, startOnboarding } from "./onboarding.js";
import {
  answerTap,
  APPROVAL_PROMPT,
  keepTyping,
  parseApprovalButton,
  parseFollowUpButton,
  parseReminderButton,
  sendApproval,
  sendText,
  settleButtons,
} from "./telegram/send.js";
import { answerFollowUp, applyReminderTap } from "./tools/reminders.js";
import type { InboundMedia, InboundMessage } from "./telegram/types.js";
import type { TurnFile } from "./tools/types.js";

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

/** The file in a message, as tools can keep and resend it. */
function turnFiles(msg: InboundMessage): TurnFile[] {
  if (!msg.media) return [];
  const kind = ({ image: "photo", video: "video", voice: "voice", doc: "document" } as const)[msg.kind as "image" | "video" | "voice" | "doc"];
  return kind ? [{ kind, fileId: msg.media.id, mimeType: msg.media.mimeType, filename: msg.media.filename }] : [];
}

async function download(media: InboundMedia): Promise<Buffer> {
  if (media.size && media.size > MAX_DOWNLOAD_BYTES) throw new FileTooLarge();
  return downloadFile(media.id);
}

/**
 * Words the transcriber should expect from this user: course codes from their timetable, the people
 * they saved and short saved facts. ID numbers are left out: hinted digits bleed into other numbers.
 */
export function voiceHints(memory: Record<string, string>, reminderTexts: string[], people: string[]): string[] {
  const codes = reminderTexts.flatMap((t) => t.match(/\b[A-Z]{3}\s?\d{3}\b/g) ?? []);
  const facts = Object.values(memory).filter((v) => v.length <= 25 && (v.match(/\d/g) ?? []).length <= 3);
  return [...new Set([...codes, ...people, ...facts])].slice(0, 40);
}

async function loadVoiceHints(userId: string, memory: Record<string, string>): Promise<string[]> {
  const [reminders, people] = await Promise.all([
    db.from("reminders").select("text").eq("user_id", userId).eq("status", "active").in("source", ["timetable", "exams"]).limit(100),
    db.from("people").select("name").eq("user_id", userId).limit(50),
  ]);
  return voiceHints(memory, (reminders.data ?? []).map((r) => r.text), (people.data ?? []).map((p) => p.name));
}

async function readInbound(msg: InboundMessage, memory: Record<string, string>, userId: string): Promise<Inbound> {
  const caption = msg.text?.trim() ?? "";
  const media = msg.media;
  switch (msg.kind) {
    case "text":
      return { text: caption, parts: [], label: caption };
    case "voice": {
      const audio = await download(media!);
      const transcript = await transcribe(audio, await loadVoiceHints(userId, memory).catch(() => []));
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

async function reply(
  user: User,
  msg: InboundMessage,
  inbound: Inbound,
  memory: Record<string, string>,
  earlier: ContentPart[],
  files: TurnFile[],
): Promise<string> {
  if (msg.kind === "other") return "I can work with text, voice notes, photos, videos and PDFs. Send me one of those.";
  if (!inbound.text && !inbound.parts.length && !earlier.length) {
    return msg.kind === "voice"
      ? "I could not make out that voice note. Could you try again?"
      : "I can read photos and PDFs. That file type is not one I can open yet.";
  }

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
    { ctx: { user, files }, system: systemPrompt({ user, memory, now: new Date() }), history, content },
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
const heldMedia = new Map<string, { parts: ContentPart[]; files: TurnFile[]; at: number }>();

/** The last files each user sent, so a follow-up such as "make it blue" still has the photo. */
const RECENT_FILES_MS = 30 * 60 * 1000;
const recentFiles = new Map<string, { files: TurnFile[]; at: number }>();

function filesForTurn(userKey: string, files: TurnFile[]): TurnFile[] {
  if (files.length) {
    recentFiles.set(userKey, { files, at: Date.now() });
    return files;
  }
  const recent = recentFiles.get(userKey);
  return recent && Date.now() - recent.at < RECENT_FILES_MS ? recent.files : [];
}

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

const REMINDER_TAP_LABEL = { done: "Done", "1h": "In 1 hour", tmr: "Tomorrow" } as const;

/** A tapped button: approval, reminder or onboarding. Taps never count towards the daily limit. */
async function handleTap(user: User, msg: InboundMessage): Promise<void> {
  const data = msg.buttonId ?? "";
  const callback = msg.callback!;

  if (data.startsWith("ob:")) {
    const toast = await handleOnboardingTap(user, data, callback.messageId).catch((err) => {
      logger.error({ err, from: maskId(msg.from) }, "onboarding tap failed");
      return "Something went wrong. Please try again.";
    });
    // Type buttons stay so more can be tapped; every other onboarding button is used once.
    if (data.startsWith("ob:type:") || toast === "Tap at least one first.") await answerTap(callback.id, toast || undefined);
    else await settleButtons(msg.from, callback, toast || undefined);
    return;
  }

  const followUp = parseFollowUpButton(data);
  if (followUp) {
    const reply = await answerFollowUp(user.id, followUp.done, followUp.reminderId).catch((err) => {
      logger.error({ err, from: maskId(msg.from) }, "follow-up tap failed");
      return { toast: "Something went wrong. Please try again.", text: null };
    });
    await settleButtons(msg.from, callback, reply.toast);
    await saveMessage(user.id, "in", "text", followUp.done ? "Yes, done" : "Not yet", msg.id);
    if (reply.text) {
      const outId = await sendText(user.chat_id, reply.text);
      await saveMessage(user.id, "out", "text", `${reply.text}
(reminder id ${followUp.reminderId})`, outId);
    }
    return;
  }

  const reminder = parseReminderButton(data);
  if (reminder) {
    const toast = await applyReminderTap(user.id, reminder.tap, reminder.reminderId).catch((err) => {
      logger.error({ err, from: maskId(msg.from) }, "reminder tap failed");
      return "Something went wrong. Please try again.";
    });
    await settleButtons(msg.from, callback, toast);
    await saveMessage(user.id, "in", "text", `[tapped ${REMINDER_TAP_LABEL[reminder.tap]} on a reminder: ${toast}]`, msg.id);
    return;
  }

  await settleButtons(msg.from, callback);
  const tapped = parseApprovalButton(data);
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
  if (msg.kind === "text" && isDemoCommand(msg.text ?? "") && isOwner(msg.from)) {
    const note = await runDemo(user, msg.text!).catch((err) => {
      logger.error({ err }, "demo command failed");
      return "That demo command failed. Check the logs.";
    });
    if (note) await sendText(user.chat_id, note);
    return;
  }
  if (msg.kind === "text" && (await handleSetupText(user, msg))) return;

  const stopTyping = keepTyping(msg.from);
  let answer: string;
  try {
    const memory = await loadMemory(user.id);
    if (msg.kind === "video") await sendText(msg.from, "On it, looking at your video...");
    const inbound = await readInbound(msg, memory, user.id);
    await saveMessage(user.id, "in", msg.kind, inbound.label, msg.id);

    const held = heldMedia.get(msg.from);
    heldMedia.delete(msg.from);
    const fresh = held && Date.now() - held.at < HELD_MEDIA_MS;
    const earlier = fresh ? held.parts : [];
    const files = [...(fresh ? held.files : []), ...turnFiles(msg)];

    if (inbound.parts.length && !inbound.text) {
      // Keep it for the next message too, in case the user answers a question about it.
      heldMedia.set(msg.from, { parts: [...earlier, ...inbound.parts], files, at: Date.now() });
      if (await followUpIsQueued(msg.from)) {
        logger.info({ from: maskId(msg.from), kind: msg.kind }, "media held for the next message");
        return;
      }
    }
    // A bare YES or NO must reach the gate on its own first; reply() adds the held media
    // back if no action was waiting.
    const isAnswer = Boolean(classifyReply(inbound.text));
    if (!isAnswer) inbound.parts = [...earlier, ...inbound.parts];

    answer = await reply(user, msg, inbound, memory, isAnswer ? earlier : [], filesForTurn(msg.from, files));
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

  // Someone who skipped /start and went straight to a task is invited to set up afterwards, once.
  if (!user.onboarded_at && !user.onboarding_step) await startOnboarding(user).catch((err) => logger.error({ err }, "onboarding invite failed"));
}

/** /start, "menu" and answers to onboarding questions. Returns true when the message was handled here. */
async function handleSetupText(user: User, msg: InboundMessage): Promise<boolean> {
  const text = msg.text?.trim() ?? "";
  const isStart = /^\/start\b/.test(text);
  const isMenu = isMenuRequest(text);
  if (!isStart && !isMenu && user.onboarding_step !== "name") return false;

  try {
    if (isStart) {
      await saveMessage(user.id, "in", "text", text, msg.id);
      const outId = await sendText(user.chat_id, WELCOME);
      await saveMessage(user.id, "out", "text", WELCOME, outId);
      if (!user.onboarded_at) await startOnboarding(user);
      return true;
    }
    if (isMenu) {
      await saveMessage(user.id, "in", "text", text, msg.id);
      await startOnboarding(user, true);
      return true;
    }
    if (await handleOnboardingText(user, text)) {
      await saveMessage(user.id, "in", "text", text, msg.id);
      return true;
    }
  } catch (err) {
    logger.error({ err, from: maskId(msg.from) }, "onboarding failed");
    await sendText(user.chat_id, 'Something went wrong on my side. Say "menu" to try the setup again.');
    return true;
  }
  // Not an onboarding answer after all: it goes on to the agent as a normal message.
  user.onboarding_step = "later";
  return false;
}
