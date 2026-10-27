import { describe, expect, it } from "vitest";
import { reminderMessage } from "../src/jobs/tick.js";
import { featuresFor, isMenuRequest, looksLikeName } from "../src/onboarding.js";
import { fromLagos } from "../src/time.js";

describe("onboarding", () => {
  it("works out what to focus on from the user's types", () => {
    const student = featuresFor(["student"]);
    expect(student).toEqual(expect.arrayContaining(["timetable", "exams", "reminders", "fake_check"]));
    expect(student).not.toContain("invoices");
    expect(featuresFor(["business"])).toContain("invoices");
  });

  it("tells a name from a task or an answer", () => {
    expect(looksLikeName("Amaka")).toBe(true);
    expect(looksLikeName("Chukwuemeka Obi")).toBe(true);
    expect(looksLikeName("Gordon’s")).toBe(true);
    expect(looksLikeName("yes")).toBe(false);
    expect(looksLikeName("what can you do?")).toBe(false);
    expect(looksLikeName("remind me to call my mum on Sunday")).toBe(false);
  });

  it("recognises a request to change the setup", () => {
    expect(isMenuRequest("menu")).toBe(true);
    expect(isMenuRequest("/menu")).toBe(true);
    expect(isMenuRequest("change my setup")).toBe(true);
    expect(isMenuRequest("what is on the menu at the party")).toBe(false);
  });
});

describe("reminderMessage", () => {
  const now = fromLagos("2026-10-28T09:00")!;
  const base = { id: "3f2a91c0-0000-4000-8000-000000000001", text: "Call Mum", repeat: null };

  it("keeps the id out of the chat but in history, for snoozing", () => {
    const m = reminderMessage({ ...base, due_at: now.toISOString() }, null, now);
    expect(m.shown).toBe("*Reminder:* Call Mum");
    expect(m.stored).toContain(base.id);
  });

  it("says when a late reminder was due, and when a repeating one comes next", () => {
    const due = fromLagos("2026-10-28T07:00")!;
    const next = fromLagos("2026-10-29T07:00")!;
    const m = reminderMessage({ ...base, due_at: due.toISOString(), repeat: { every: "day" } }, next, now);
    expect(m.shown).toContain("This was due today, 7:00am");
    expect(m.shown).toContain("Next one: tomorrow, 7:00am");
  });
});
