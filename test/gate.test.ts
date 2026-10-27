import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAgent, type Complete } from "../src/ai/agent.js";
import { classifyReply, DAILY_EMAIL_CAP, SafetyGate, STALE_BUTTON, startOfLagosDay, type GateStore, type PendingAction } from "../src/safety/gate.js";
import { parseApprovalButton } from "../src/telegram/send.js";
import type { ActionLogEntry } from "../src/tools/log.js";
import { defineTool } from "../src/tools/types.js";

const ALICE = "user-alice";
const BOB = "user-bob";
const EMAIL_TOOLS = new Set(["send_email"]);

class MemoryStore implements GateStore {
  actions: PendingAction[] = [];
  logs: ActionLogEntry[] = [];
  async expireWaiting(userId: string) {
    for (const a of this.actions) if (a.userId === userId && a.status === "waiting") a.status = "expired";
  }
  async createPending(p: Omit<PendingAction, "id" | "status">) {
    const a: PendingAction = { ...p, id: randomUUID(), status: "waiting" };
    this.actions.push(a);
    return a;
  }
  async latestWaiting(userId: string) {
    return [...this.actions].reverse().find((a) => a.userId === userId && a.status === "waiting") ?? null;
  }
  async settle(id: string, to: Exclude<PendingAction["status"], "waiting">) {
    const a = this.actions.find((x) => x.id === id);
    if (!a || a.status !== "waiting") return false;
    a.status = to;
    return true;
  }
  async countSentSince(userId: string, tools: Set<string>) {
    return this.logs.filter((l) => l.userId === userId && l.status === "done" && tools.has(l.tool)).length;
  }
  async log(entry: ActionLogEntry) {
    this.logs.push(entry);
  }
}

function setup(start = new Date("2026-10-28T10:00:00Z")) {
  let now = start;
  const store = new MemoryStore();
  const execute = vi.fn(async (a: PendingAction) => `sent ${JSON.stringify(a.args)}`);
  const gate = new SafetyGate({ store, execute, emailTools: EMAIL_TOOLS, now: () => now });
  return { store, execute, gate, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const ask = (gate: SafetyGate, userId = ALICE, body = "hello") =>
  gate.request(userId, "send_email", { to: "chidi@example.com", subject: "Hi", body }, `Email chidi: ${body}`);

describe("classifyReply", () => {
  it.each(["YES", "yes", "Yes!", " ok ", "Go ahead.", "oya send", "sure"])("treats %j as yes", (t) => expect(classifyReply(t)).toBe("yes"));
  it.each(["no", "NO.", "cancel", "don't", "abeg no"])("treats %j as no", (t) => expect(classifyReply(t)).toBe("no"));
  it.each(["yes but change the subject", "is it sent?", "", "yesterday", "know"])("treats %j as neither", (t) => expect(classifyReply(t)).toBeNull());
});

describe("SafetyGate", () => {
  it("does not run anything when an action is requested", async () => {
    const { gate, execute, store } = setup();
    const res = await ask(gate);
    expect(res.ok).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(store.logs.map((l) => l.status)).toEqual(["asked"]);
  });

  it("runs the action exactly once after YES from the same user, and logs each step", async () => {
    const { gate, execute, store } = setup();
    await ask(gate);
    expect(await gate.answer(ALICE, "yes")).toContain("sent");
    expect(await gate.answer(ALICE, "yes")).toBeNull(); // nothing left waiting
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.logs.map((l) => l.status)).toEqual(["asked", "approved", "done"]);
  });

  it("ignores YES from a different user", async () => {
    const { gate, execute } = setup();
    await ask(gate, ALICE);
    expect(await gate.answer(BOB, "yes")).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    // Alice's action is still waiting for Alice.
    expect(await gate.answer(ALICE, "yes")).toContain("sent");
  });

  it("does not run on anything other than a clear yes", async () => {
    const { gate, execute } = setup();
    await ask(gate);
    for (const t of ["yes but later", "send it to Ada instead", "hmm", "what is this?"]) {
      expect(await gate.answer(ALICE, t)).toBeNull();
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels on NO, and a later YES does nothing", async () => {
    const { gate, execute, store } = setup();
    await ask(gate);
    expect(await gate.answer(ALICE, "no")).toMatch(/cancelled/i);
    expect(await gate.answer(ALICE, "yes")).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    expect(store.logs.at(-1)?.status).toBe("declined");
  });

  it("a tapped button only answers the action it was sent with", async () => {
    const { gate, execute } = setup();
    const first = await ask(gate);
    const second = await ask(gate);
    if (!first.ok || !second.ok) throw new Error("not asked");
    expect(await gate.answer(ALICE, "YES", first.action.id)).toBe(STALE_BUTTON);
    expect(execute).not.toHaveBeenCalled();
    expect(await gate.answer(ALICE, "YES", second.action.id)).toContain("sent");
    // Tapping again after it ran changes nothing.
    expect(await gate.answer(ALICE, "YES", second.action.id)).toBe(STALE_BUTTON);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reads approval button ids", () => {
    expect(parseApprovalButton("yes:abc-123")).toEqual({ decision: "YES", actionId: "abc-123" });
    expect(parseApprovalButton("no:abc-123")).toEqual({ decision: "NO", actionId: "abc-123" });
    expect(parseApprovalButton("menu:invoices")).toBeNull();
    expect(parseApprovalButton(undefined)).toBeNull();
  });

  it("expires after 30 minutes", async () => {
    const { gate, execute, advance, store } = setup();
    await ask(gate);
    advance(30 * 60 * 1000 + 1);
    expect(await gate.answer(ALICE, "yes")).toMatch(/expired/i);
    expect(execute).not.toHaveBeenCalled();
    expect(store.logs.at(-1)?.status).toBe("expired");
  });

  it("still works just inside 30 minutes", async () => {
    const { gate, execute, advance } = setup();
    await ask(gate);
    advance(29 * 60 * 1000);
    await gate.answer(ALICE, "yes");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("only the newest request can be approved", async () => {
    const { gate, execute } = setup();
    await ask(gate, ALICE, "first");
    await ask(gate, ALICE, "second");
    await gate.answer(ALICE, "yes");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].args).toMatchObject({ body: "second" });
  });

  it("runs once even when two YES replies race", async () => {
    const { gate, execute } = setup();
    await ask(gate);
    await Promise.all([gate.answer(ALICE, "yes"), gate.answer(ALICE, "yes")]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it(`refuses new email requests after ${DAILY_EMAIL_CAP} sends in a day`, async () => {
    const { gate, store } = setup();
    for (let i = 0; i < DAILY_EMAIL_CAP; i++) store.logs.push({ userId: ALICE, tool: "send_email", status: "done" });
    const res = await ask(gate);
    expect(res.ok).toBe(false);
    expect(store.actions).toHaveLength(0);
  });

  it("re-checks the cap at approval time", async () => {
    const { gate, store, execute } = setup();
    await ask(gate);
    for (let i = 0; i < DAILY_EMAIL_CAP; i++) store.logs.push({ userId: ALICE, tool: "send_email", status: "done" });
    expect(await gate.answer(ALICE, "yes")).toMatch(/limit/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports a failure without claiming success, and logs it", async () => {
    const { gate, execute, store } = setup();
    execute.mockRejectedValueOnce(new Error("smtp down"));
    await ask(gate);
    expect(await gate.answer(ALICE, "yes")).toMatch(/could not/i);
    expect(store.logs.at(-1)).toMatchObject({ status: "failed", approved: true });
  });

  it("counts the day from midnight Lagos time", () => {
    expect(startOfLagosDay(new Date("2026-10-28T23:30:00Z")).toISOString()).toBe("2026-10-28T23:00:00.000Z");
    expect(startOfLagosDay(new Date("2026-10-28T10:00:00Z")).toISOString()).toBe("2026-10-27T23:00:00.000Z");
  });
});

describe("agent with the gate", () => {
  const sendRun = vi.fn(async () => ({ message: "really sent" }));
  const fakeEmail = defineTool({
    name: "send_email",
    description: "email",
    sensitive: true,
    schema: z.object({ to: z.email(), subject: z.string(), body: z.string() }),
    summarize: (a) => `Email ${a.to}: ${a.body}`,
    run: sendRun,
  });
  const ctx = { user: { id: ALICE, wa_id: "2348000000001", name: "Alice", business_name: null } };

  /** A scripted model that asks for the given tool calls on its first turn. */
  const model = (calls: { name: string; args: unknown }[], text = "Done."): Complete => {
    let turn = 0;
    return async () =>
      turn++ === 0
        ? {
            role: "assistant",
            content: "On it.",
            refusal: null,
            tool_calls: calls.map((c, i) => ({ id: `call_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
          }
        : { role: "assistant", content: text, refusal: null };
  };

  it("never runs a sensitive tool the model calls; it asks for YES instead", async () => {
    const { gate, store } = setup();
    const reply = await runAgent(
      { ctx, system: "", history: [], content: "email chidi hello" },
      { gate, tools: [fakeEmail], complete: model([{ name: "send_email", args: { to: "chidi@example.com", subject: "Hi", body: "hello" } }]) },
    );
    expect(sendRun).not.toHaveBeenCalled();
    expect(store.actions).toHaveLength(1);
    expect(reply).toContain("Email chidi@example.com: hello");
    expect(reply).toMatch(/YES/);
  });

  it("does not create an approval for invalid arguments", async () => {
    const { gate, store } = setup();
    await runAgent(
      { ctx, system: "", history: [], content: "email chidi" },
      { gate, tools: [fakeEmail], complete: model([{ name: "send_email", args: { to: "not-an-email", subject: "Hi", body: "x" } }], "What is Chidi's email?") },
    );
    expect(store.actions).toHaveLength(0);
    expect(sendRun).not.toHaveBeenCalled();
  });

  it("keeps an explanation above the approval request but drops claims that it is sending", async () => {
    const run = (content: string) => {
      const { gate } = setup();
      const complete: Complete = async () => ({
        role: "assistant",
        content,
        refusal: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "send_email", arguments: JSON.stringify({ to: "a@example.com", subject: "Re", body: "ok" }) } }],
      });
      return runAgent({ ctx, system: "", history: [], content: "x" }, { gate, tools: [fakeEmail], complete });
    };
    expect(await run("This is a rent notice from your landlord asking for N50,000 by Friday.")).toMatch(/^This is a rent notice/);
    expect(await run("I will send it now.")).toMatch(/^Email a@example.com/);
    expect(await run("Done, sending this to them.")).toMatch(/^Email a@example.com/);
    expect(await run("I'll resend invoice INV-0001 to Chidi now.")).toMatch(/^Email a@example.com/);
    expect(await run("Got the email, na to send am now.")).toMatch(/^Email a@example.com/);
  });

  it("shows a tool's explanation above the approval request, in place of the model's text", async () => {
    const { gate } = setup();
    const explain = defineTool({
      name: "explain_document",
      description: "explain",
      sensitive: false,
      schema: z.object({ what_it_is: z.string() }),
      run: async (a) => ({ message: "ok", showUser: `*What it is:* ${a.what_it_is}` }),
    });
    const complete: Complete = async () => ({
      role: "assistant",
      content: "I'll explain that and draft your reply.",
      refusal: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "explain_document", arguments: JSON.stringify({ what_it_is: "A rent notice" }) } },
        { id: "c2", type: "function", function: { name: "send_email", arguments: JSON.stringify({ to: "a@example.com", subject: "Re", body: "ok" }) } },
      ],
    });
    const reply = await runAgent({ ctx, system: "", history: [], content: "x" }, { gate, tools: [explain, fakeEmail], complete });
    expect(reply).toMatch(/^\*What it is:\* A rent notice\n\nEmail a@example.com: ok\n\nReply \*YES\*/);
    expect(sendRun).not.toHaveBeenCalled();
  });

  it("retries once when the model returns an empty message, and never replies with nothing", async () => {
    const { gate } = setup();
    const replies = ["", "Here is your answer."];
    const complete: Complete = async () => ({ role: "assistant", content: replies.shift() ?? "", refusal: null });
    expect(await runAgent({ ctx, system: "", history: [], content: "x" }, { gate, tools: [fakeEmail], complete })).toBe("Here is your answer.");

    const silent: Complete = async () => ({ role: "assistant", content: "", refusal: null });
    expect(await runAgent({ ctx, system: "", history: [], content: "x" }, { gate, tools: [fakeEmail], complete: silent })).toMatch(/send it again/);
  });

  it("allows only one waiting action per turn", async () => {
    const { gate, store } = setup();
    const args = (to: string) => ({ to, subject: "Hi", body: "hello" });
    await runAgent(
      { ctx, system: "", history: [], content: "email both" },
      { gate, tools: [fakeEmail], complete: model([{ name: "send_email", args: args("a@example.com") }, { name: "send_email", args: args("b@example.com") }]) },
    );
    expect(store.actions).toHaveLength(1);
    expect(sendRun).not.toHaveBeenCalled();
  });

  it("checks one product per message, so an old pack from the chat is not checked again", async () => {
    const { gate } = setup();
    const checkRun = vi.fn(async (a: { name: string }) => ({ message: "ok", showUser: `Checked ${a.name}` }));
    const check = defineTool({ name: "check_product", description: "check", sensitive: false, schema: z.object({ name: z.string() }), run: checkRun });
    const steps = [
      { role: "assistant" as const, content: null, refusal: null, tool_calls: [
        { id: "c1", type: "function" as const, function: { name: "check_product", arguments: JSON.stringify({ name: "Ginny" }) } },
        { id: "c2", type: "function" as const, function: { name: "check_product", arguments: JSON.stringify({ name: "Zentel" }) } },
      ] },
      { role: "assistant" as const, content: "Done.", refusal: null },
    ];
    const reply = await runAgent({ ctx, system: "", history: [], content: "x" }, { gate, tools: [check], complete: async () => steps.shift()! });
    expect(checkRun).toHaveBeenCalledTimes(1);
    expect(reply).toBe("Checked Ginny\n\nDone.");
  });
});
