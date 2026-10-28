import { describe, expect, it } from "vitest";
import { reminderMessage } from "../src/jobs/tick.js";
import { featuresFor, isMenuRequest, looksLikeName } from "../src/onboarding.js";
import { fromLagos } from "../src/time.js";
import { findClashes, isDuplicate } from "../src/tools/reminders.js";

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

describe("reminder duplicates and clashes", () => {
  const at = (local: string) => fromLagos(local)!.toISOString();

  it("treats two wordings of the same exam reminder at the same moment as one", () => {
    const existing = [{ text: "CSC 201 - Computer Programming I exam in 3 days", due_at: at("2026-11-01T19:00") }];
    expect(isDuplicate("CSC 201 exam in 3 days", at("2026-11-01T19:00"), existing)).toBe(true);
    expect(isDuplicate("MTH 201 exam in 3 days", at("2026-11-01T19:00"), existing)).toBe(false);
    expect(isDuplicate("CSC 201 exam in 3 days", at("2026-11-02T19:00"), existing)).toBe(false);
  });

  it("matches plain reminders by their words", () => {
    const existing = [{ text: "Call Mum", due_at: at("2026-11-01T09:00") }];
    expect(isDuplicate("call mum", at("2026-11-01T09:00"), existing)).toBe(true);
    expect(isDuplicate("Buy data", at("2026-11-01T09:00"), existing)).toBe(false);
  });

  it("finds a weekly class near a new reminder", () => {
    const mth = { text: "MTH 201 in LT5 at 10:00am", due_at: at("2026-11-02T09:30"), repeat: { every: "week" as const, weekdays: [1] } };
    expect(findClashes(fromLagos("2026-11-09T09:00")!, [mth])).toHaveLength(1);
    expect(findClashes(fromLagos("2026-11-10T09:00")!, [mth])).toHaveLength(0);
  });
});

describe("voice hints and notes", () => {
  it("hints course codes and names, never long ID numbers", async () => {
    const { voiceHints } = await import("../src/handle.js");
    const hints = voiceHints({ matric_number: "LCU/CSC/24/0457", business_name: "Degordons" }, ["CSC 201 in LT2 at 8:00am", "MTH 201 exam in 3 days"], ["Tobi"]);
    expect(hints).toEqual(expect.arrayContaining(["CSC 201", "MTH 201", "Tobi", "Degordons"]));
    expect(hints).not.toContain("LCU/CSC/24/0457");
  });

  it("knows two titles for the same note", async () => {
    const { sameNote } = await import("../src/tools/keep.js");
    expect(sameNote("Test study plan Nov 2026", "Test study plan - 2hrs daily")).toBe(true);
    expect(sameNote("Dinner Night", "Test study plan")).toBe(false);
  });
});
