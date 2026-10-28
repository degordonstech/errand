import { describe, expect, it } from "vitest";
import { describeRepeat, describeWhen, firstOccurrence, fromLagos, nextOccurrence, toLagos } from "../src/time.js";

const at = (local: string) => fromLagos(local)!;

describe("Lagos time", () => {
  it("converts wall clock both ways at UTC+1", () => {
    expect(at("2026-10-30T09:00").toISOString()).toBe("2026-10-30T08:00:00.000Z");
    expect(toLagos(new Date("2026-10-30T23:30:00Z"))).toBe("2026-10-31T00:30");
  });
  it("rejects unreadable and impossible dates", () => {
    expect(fromLagos("next friday")).toBeNull();
    expect(fromLagos("2026-02-31T09:00")).toBeNull();
  });
  it("describes times relative to today", () => {
    const now = at("2026-10-28T20:00");
    expect(describeWhen(at("2026-10-28T21:30"), now)).toBe("today, 9:30pm");
    expect(describeWhen(at("2026-10-29T07:05"), now)).toBe("tomorrow, 7:05am");
    expect(describeWhen(at("2026-10-30T12:00"), now)).toBe("Fri 30 Oct, 12:00pm");
  });
});

describe("nextOccurrence", () => {
  const from = at("2026-10-28T08:00"); // a Wednesday

  it("steps daily, every n days and monthly", () => {
    expect(toLagos(nextOccurrence({ every: "day" }, from, from)!)).toBe("2026-10-29T08:00");
    expect(toLagos(nextOccurrence({ every: "day", interval: 3 }, from, from)!)).toBe("2026-10-31T08:00");
    expect(toLagos(nextOccurrence({ every: "month" }, from, from)!)).toBe("2026-11-28T08:00");
    expect(toLagos(nextOccurrence({ every: "year" }, from, from)!)).toBe("2027-10-28T08:00");
  });

  it("keeps the 31st on the last day of shorter months", () => {
    const end = at("2026-01-31T09:00");
    expect(toLagos(nextOccurrence({ every: "month" }, end, end)!)).toBe("2026-02-28T09:00");
  });

  it("picks the next listed weekday", () => {
    // Mon, Wed, Fri: after Wednesday comes Friday, then Monday.
    const r = { every: "week" as const, weekdays: [1, 3, 5] };
    const fri = nextOccurrence(r, from, from)!;
    expect(toLagos(fri)).toBe("2026-10-30T08:00");
    expect(toLagos(nextOccurrence(r, fri, fri)!)).toBe("2026-11-02T08:00");
  });

  it("skips ahead past a long gap instead of firing every missed slot", () => {
    expect(toLagos(nextOccurrence({ every: "day" }, from, at("2026-11-10T12:00"))!)).toBe("2026-11-11T08:00");
  });

  it("stops after the until date", () => {
    expect(nextOccurrence({ every: "day", until: "2026-10-28" }, from, from)).toBeNull();
    expect(toLagos(nextOccurrence({ every: "day", until: "2026-10-29" }, from, from)!)).toBe("2026-10-29T08:00");
  });
});

describe("describeRepeat", () => {
  it("reads naturally", () => {
    expect(describeRepeat({ every: "day" })).toBe("every day");
    expect(describeRepeat({ every: "week", weekdays: [5, 1, 3] })).toBe("every Mon, Wed, Fri");
    expect(describeRepeat({ every: "week", weekdays: [1, 2, 3, 4, 5] })).toBe("every weekday");
    expect(describeRepeat({ every: "month", interval: 2, until: "2027-06-30" })).toBe("every 2 months until 2027-06-30");
  });
});

describe("firstOccurrence", () => {
  const now = at("2026-10-28T10:00"); // Wednesday
  it("keeps a future one-off and refuses a past one", () => {
    expect(toLagos(firstOccurrence(at("2026-10-28T18:00"), null, now)!)).toBe("2026-10-28T18:00");
    expect(firstOccurrence(at("2026-10-28T09:00"), null, now)).toBeNull();
  });
  it("starts a weekly repeat on its first listed day", () => {
    // Asked on Wednesday for "Mondays and Thursdays at 8am".
    expect(toLagos(firstOccurrence(at("2026-10-28T08:00"), { every: "week", weekdays: [1, 4] }, now)!)).toBe("2026-10-29T08:00");
  });
  it("moves a repeat whose first slot has passed to the next one", () => {
    expect(toLagos(firstOccurrence(at("2026-10-28T08:00"), { every: "day" }, now)!)).toBe("2026-10-29T08:00");
  });
});

describe("describeWhen across years", () => {
  it("shows the year when the date is in another year", () => {
    const now = at("2026-10-28T12:00");
    expect(describeWhen(at("2027-11-14T08:00"), now)).toBe("Sun 14 Nov 2027, 8:00am");
    expect(describeWhen(at("2026-11-14T08:00"), now)).toBe("Sat 14 Nov, 8:00am");
  });
});
