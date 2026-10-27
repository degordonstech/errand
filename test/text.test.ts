import { describe, expect, it } from "vitest";
import { cleanReply } from "../src/text.js";

describe("cleanReply", () => {
  it("removes emoji and long dashes", () => {
    expect(cleanReply("Saved ✅ — all done")).toBe("Saved, all done");
  });

  it("keeps number ranges", () => {
    expect(cleanReply("Open 9–5 daily")).toBe("Open 9-5 daily");
  });

  it("converts Markdown bold and headings to WhatsApp bold", () => {
    expect(cleanReply("## Invoice\n**Total:** N225,000")).toBe("*Invoice*\n*Total:* N225,000");
  });
});
