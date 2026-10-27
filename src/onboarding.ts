import { saveMessage, updateUser, type User } from "./db/supabase.js";
import { classifyReply } from "./safety/gate.js";
import { call } from "./telegram/api.js";

export const TYPES = [
  { id: "student", label: "Student" },
  { id: "working", label: "Working" },
  { id: "business", label: "I run a business" },
  { id: "other", label: "Something else" },
] as const;

type TypeId = (typeof TYPES)[number]["id"];

interface Feature {
  id: string;
  /** How the agent describes it. Never shown to the user as a list. */
  label: string;
  /** Who it is chosen for. "all" means everyone gets it. */
  for: TypeId[] | "all";
}

export const FEATURES: Feature[] = [
  { id: "timetable", label: "reminders before every class, from their timetable", for: ["student"] },
  { id: "exams", label: "exam countdowns and a study plan", for: ["student"] },
  { id: "study", label: "check-ins during study hours", for: ["student"] },
  { id: "invoices", label: "invoices and receipts, emailed after their YES", for: ["business", "working"] },
  { id: "product_photos", label: "cleaning up product photos", for: ["business"] },
  { id: "bills", label: "keeping track of bills, rent and subscriptions", for: ["working", "business", "other"] },
  { id: "contracts", label: "checking a contract or agreement before they sign", for: ["working", "business", "other"] },
  { id: "reminders", label: "reminders for anything, once or on repeat", for: "all" },
  { id: "memory", label: "remembering numbers, details, documents and people", for: "all" },
  { id: "events", label: "saving dates from invites, flyers and birthdays", for: "all" },
  { id: "notes", label: "turning voice notes into to-do lists and notes", for: "all" },
  { id: "fake_check", label: "checking if a drug or product is fake", for: "all" },
  { id: "letters", label: "explaining letters and drafting replies", for: "all" },
];

/** What MyPaddy focuses on for someone, worked out from their types. */
export function featuresFor(types: string[]): string[] {
  return FEATURES.filter((f) => f.for === "all" || f.for.some((t) => types.includes(t))).map((f) => f.id);
}

/** How MyPaddy introduces itself to each type, and the one thing to try first. */
const INTROS: Record<TypeId, { intro: string; first: string }> = {
  student: {
    intro: "I'll remind you before your classes, count down to exams with you, and help you stay on track with studying.",
    first: "Send me a photo of your timetable and I'll set up your class reminders.",
  },
  business: {
    intro: "I'll make your invoices and chase payments, keep track of your bills, and remember your customers' details.",
    first: 'Try: "Make invoice for Ada, 2 bags of beans, 40k each"',
  },
  working: {
    intro: "I'll keep track of your bills and deadlines, remind you of anything, and help you with emails and letters.",
    first: 'Try: "My rent is due on the 1st of every month, remind me 3 days before"',
  },
  other: {
    intro: "I'll remember things for you, remind you of anything, and handle small tasks so you don't have to.",
    first: 'Try: "Remind me to call Mum on Sunday at 6pm"',
  },
};

/** Phone keyboards type curly apostrophes, as in "Gordon’s". */
const normaliseName = (text: string) => text.trim().replace(/[‘’ʼ]/g, "'");

/** A short reply that reads as a name, not a question or a task. */
export function looksLikeName(text: string): boolean {
  const t = normaliseName(text);
  return t.length >= 2 && t.length <= 40 && /^[\p{L}][\p{L}' .-]*$/u.test(t) && t.split(/\s+/).length <= 4 && !classifyReply(t);
}

const typeKeyboard = (picked: string[]) => ({
  inline_keyboard: [
    ...TYPES.map((t) => [{ text: picked.includes(t.id) ? `${t.label} (picked)` : t.label, callback_data: `ob:type:${t.id}` }]),
    [{ text: "Done", callback_data: "ob:types:done" }],
  ],
});

const BRIEF_TIMES = ["06:00", "07:00", "08:00", "09:00"];
const briefLabel = (t: string) => `${Number(t.slice(0, 2))}am`;

/** Setup questions go into the chat history too, so the agent knows what was just asked. */
async function send(user: User, text: string, replyMarkup?: unknown): Promise<void> {
  const res = await call<{ message_id: number }>("sendMessage", { chat_id: user.chat_id, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  await saveMessage(user.id, "out", "text", text, String(res.message_id));
}

async function askName(user: User): Promise<void> {
  await updateUser(user.id, { onboarding_step: "name" });
  const first = user.name?.split(" ")[0];
  await send(
    user,
    "Let me get to know you a little, so I can be more useful. What should I call you?",
    first ? { inline_keyboard: [[{ text: `Call me ${first}`, callback_data: "ob:name:keep" }]] } : undefined,
  );
}

async function askTypes(user: User, name: string | null): Promise<void> {
  await updateUser(user.id, { onboarding_step: "types", types: [] });
  await send(user, `${name ? `Nice to meet you, ${name}. ` : ""}Which of these sounds like you? Tap all that apply, then Done.`, typeKeyboard([]));
}

async function askBriefTime(user: User): Promise<void> {
  await updateUser(user.id, { onboarding_step: "brief" });
  await send(user, "Last one. Do you want a short morning brief of your day? Pick a time.", {
    inline_keyboard: [BRIEF_TIMES.map((t) => ({ text: briefLabel(t), callback_data: `ob:brief:${t}` })), [{ text: "No thanks", callback_data: "ob:brief:none" }]],
  });
}

async function finish(user: User, briefTime: string | null): Promise<void> {
  await updateUser(user.id, { onboarding_step: null, onboarded_at: new Date().toISOString(), features: featuresFor(user.types), brief_time: briefTime });
  const main = INTROS[TYPES.find((t) => user.types.includes(t.id))?.id ?? "other"];
  const brief = briefTime ? ` Your morning brief comes at ${briefLabel(briefTime)}.` : "";
  const name = user.preferred_name ? `, ${user.preferred_name}` : "";
  await send(user, `All set${name}. ${main.intro}${brief}\n\nTo start: ${main.first}\n\nYou can ask me for anything else too. Say "menu" any time to change this.`);
}

/** "menu", "/menu" or "change my setup" restarts the setup from the types question. */
export function isMenuRequest(text: string): boolean {
  return /^\/?(menu|setup|change (my )?(setup|settings))\.?$/i.test(text.trim());
}

export async function startOnboarding(user: User, fromMenu = false): Promise<void> {
  if (fromMenu) await askTypes(user, null);
  else await askName(user);
}

/**
 * Handles a text reply while onboarding is in progress. Returns true when the message was
 * an onboarding answer. Anything else goes on to the agent, so onboarding never blocks a task.
 */
export async function handleOnboardingText(user: User, text: string): Promise<boolean> {
  if (user.onboarding_step !== "name") return false;
  if (!looksLikeName(text)) {
    // They moved on to something else. Do not keep asking; "menu" brings it back.
    await updateUser(user.id, { onboarding_step: "later" });
    return false;
  }
  const name = normaliseName(text).replace(/^(call me|my name is|i am|i'm|na)\s+/i, "");
  await updateUser(user.id, { preferred_name: name });
  await askTypes(user, name);
  return true;
}

/** Handles a tap on an onboarding button. Returns a toast, or null when the data is not an onboarding button. */
export async function handleOnboardingTap(user: User, data: string, messageId: number): Promise<string | null> {
  if (data === "ob:name:keep") {
    const name = user.name?.split(" ")[0] ?? null;
    await updateUser(user.id, { preferred_name: name });
    await askTypes(user, name);
    return "";
  }
  const type = data.match(/^ob:type:(\w+)$/)?.[1];
  if (type && TYPES.some((t) => t.id === type)) {
    const types = user.types.includes(type) ? user.types.filter((t) => t !== type) : [...user.types, type];
    await updateUser(user.id, { types, onboarding_step: "types" });
    await call("editMessageReplyMarkup", { chat_id: user.chat_id, message_id: messageId, reply_markup: typeKeyboard(types) }).catch(() => undefined);
    return "";
  }
  if (data === "ob:types:done") {
    if (!user.types.length) return "Tap at least one first.";
    await askBriefTime(user);
    return "";
  }
  const time = data.match(/^ob:brief:(\d{2}:\d{2}|none)$/)?.[1];
  if (time && (time === "none" || BRIEF_TIMES.includes(time))) {
    await finish(user, time === "none" ? null : time);
    return "";
  }
  return null;
}
