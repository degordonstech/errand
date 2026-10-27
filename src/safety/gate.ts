import type { ActionLogEntry } from "../tools/log.js";

export const APPROVAL_TTL_MS = 30 * 60 * 1000;
export const DAILY_EMAIL_CAP = 20;

export type PendingStatus = "waiting" | "approved" | "declined" | "expired";

export interface PendingAction {
  id: string;
  userId: string;
  tool: string;
  args: unknown;
  summary: string;
  status: PendingStatus;
  expiresAt: Date;
}

export interface GateStore {
  /** Marks every waiting action for the user as expired. Only one action waits at a time. */
  expireWaiting(userId: string): Promise<void>;
  createPending(p: Omit<PendingAction, "id" | "status">): Promise<PendingAction>;
  latestWaiting(userId: string): Promise<PendingAction | null>;
  /**
   * Moves an action out of "waiting". Must be atomic: returns false if another
   * request already moved it, so a double YES cannot run the action twice.
   */
  settle(id: string, to: Exclude<PendingStatus, "waiting">): Promise<boolean>;
  countSentSince(userId: string, tools: Set<string>, since: Date): Promise<number>;
  log(entry: ActionLogEntry): Promise<void>;
}

export interface GateDeps {
  store: GateStore;
  /** Runs an approved sensitive tool. Returns the message for the user. */
  execute(action: PendingAction): Promise<string>;
  emailTools: Set<string>;
  now?: () => Date;
}

const YES = new Set(["yes", "y", "yeah", "yep", "yea", "ok", "okay", "sure", "confirm", "approve", "approved", "send", "send it", "go ahead", "do it", "oya", "oya send", "send am", "yes send", "yes please"]);
const NO = new Set(["no", "n", "nope", "cancel", "stop", "dont", "don't", "do not", "no thanks", "leave it", "leave am", "no send", "abeg no"]);

/** Only short, unambiguous replies count. Anything longer goes to the agent as a normal message. */
export function classifyReply(text: string): "yes" | "no" | null {
  const t = text
    .toLowerCase()
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (YES.has(t)) return "yes";
  if (NO.has(t)) return "no";
  return null;
}

/** Start of the current day in Lagos (UTC+1, no daylight saving). */
export function startOfLagosDay(now: Date): Date {
  const lagos = new Date(now.getTime() + 60 * 60 * 1000);
  lagos.setUTCHours(0, 0, 0, 0);
  return new Date(lagos.getTime() - 60 * 60 * 1000);
}

export const STALE_BUTTON = "That request was already answered or replaced by a newer one, so nothing changed.";

export type RequestResult = { ok: true; action: PendingAction } | { ok: false; reason: string };

export class SafetyGate {
  private now: () => Date;

  constructor(private deps: GateDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async overCap(userId: string, tool: string): Promise<boolean> {
    if (!this.deps.emailTools.has(tool)) return false;
    const sent = await this.deps.store.countSentSince(userId, this.deps.emailTools, startOfLagosDay(this.now()));
    return sent >= DAILY_EMAIL_CAP;
  }

  /** The action waiting for this user's answer, if any. */
  waiting(userId: string): Promise<PendingAction | null> {
    return this.deps.store.latestWaiting(userId);
  }

  /** Called instead of running a sensitive tool. Nothing is executed here. */
  async request(userId: string, tool: string, args: unknown, summary: string): Promise<RequestResult> {
    if (await this.overCap(userId, tool)) {
      return { ok: false, reason: `Daily limit reached: MyPaddy sends at most ${DAILY_EMAIL_CAP} emails per day.` };
    }
    await this.deps.store.expireWaiting(userId);
    const action = await this.deps.store.createPending({
      userId,
      tool,
      args,
      summary,
      expiresAt: new Date(this.now().getTime() + APPROVAL_TTL_MS),
    });
    await this.deps.store.log({ userId, tool, args, status: "asked" });
    return { ok: true, action };
  }

  /**
   * Handles a possible YES or NO from this user. Returns the reply to send,
   * or null when the message is not an answer to a waiting action.
   * Lookups are always by the sender's own user id, so one user can never approve another's action.
   */
  async answer(userId: string, text: string, actionId?: string): Promise<string | null> {
    const decision = classifyReply(text);
    if (!decision) return null;

    const action = await this.deps.store.latestWaiting(userId);
    // A tapped button names its action, so an old button can never approve a newer request.
    if (actionId && action?.id !== actionId) return STALE_BUTTON;
    if (!action) return null;

    const { store } = this.deps;
    const base = { userId, tool: action.tool, args: action.args };

    if (action.expiresAt.getTime() <= this.now().getTime()) {
      if (await store.settle(action.id, "expired")) await store.log({ ...base, status: "expired" });
      return "That request expired after 30 minutes, so nothing was sent. Ask me again if you still want it done.";
    }

    if (decision === "no") {
      if (await store.settle(action.id, "declined")) await store.log({ ...base, status: "declined" });
      return "Cancelled. Nothing was sent.";
    }

    if (await this.overCap(userId, action.tool)) {
      if (await store.settle(action.id, "declined")) await store.log({ ...base, status: "declined", result: { reason: "daily cap" } });
      return `I have already sent ${DAILY_EMAIL_CAP} emails for you today, which is the daily limit. Nothing was sent.`;
    }

    if (!(await store.settle(action.id, "approved"))) return "That one has already been handled.";
    await store.log({ ...base, status: "approved", approved: true });

    try {
      const message = await this.deps.execute(action);
      await store.log({ ...base, status: "done", approved: true, result: { message } });
      return message;
    } catch (err) {
      await store.log({ ...base, status: "failed", approved: true, result: { error: (err as Error).message } });
      return "I could not complete that. Nothing was sent. Please try again in a moment.";
    }
  }
}
