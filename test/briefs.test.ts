import { describe, expect, it } from "vitest";
import { dueBriefs, occurrences } from "../src/jobs/briefs.js";
import { fromLagos, toLagos } from "../src/time.js";

const at = (local: string) => fromLagos(local)!;

describe("dueBriefs", () => {
  it("sends the morning brief from its time for three hours", () => {
    expect(dueBriefs("07:00", at("2026-10-28T06:59"))).toEqual([]);
    expect(dueBriefs("07:00", at("2026-10-28T07:00"))).toEqual([{ kind: "morning", day: "2026-10-28" }]);
    expect(dueBriefs("07:00", at("2026-10-28T09:59")).map((b) => b.kind)).toEqual(["morning"]);
    expect(dueBriefs("07:00", at("2026-10-28T10:00"))).toEqual([]);
  });

  it("adds the evening check at 9pm, and the weekly summary on Sunday evening", () => {
    expect(dueBriefs("07:00", at("2026-10-28T21:05")).map((b) => b.kind)).toEqual(["evening"]);
    // 1 November 2026 is a Sunday.
    expect(dueBriefs("07:00", at("2026-11-01T18:30")).map((b) => b.kind)).toEqual(["weekly"]);
    expect(dueBriefs("07:00", at("2026-10-31T18:30"))).toEqual([]);
  });
});

describe("occurrences", () => {
  it("expands a repeating reminder across the window", () => {
    const r = { text: "Gym", due_at: at("2026-10-28T06:00").toISOString(), repeat: { every: "week" as const, weekdays: [1, 3, 5] } };
    const slots = occurrences(r, at("2026-10-28T00:00"), at("2026-11-04T00:00")).map((s) => toLagos(s.at));
    expect(slots).toEqual(["2026-10-28T06:00", "2026-10-30T06:00", "2026-11-02T06:00"]);
  });

  it("keeps a one-off only when it falls inside", () => {
    const r = { text: "Dues", due_at: at("2026-10-30T09:00").toISOString(), repeat: null };
    expect(occurrences(r, at("2026-10-28T00:00"), at("2026-10-29T00:00"))).toEqual([]);
    expect(occurrences(r, at("2026-10-30T00:00"), at("2026-10-31T00:00"))).toHaveLength(1);
  });
});
