import { z } from "zod";
import { defineTool } from "./types.js";

const line = (label: string, value?: string) => (value?.trim() ? `*${label}:* ${value.trim()}` : "");

export const explainDocument = defineTool({
  name: "explain_document",
  description:
    "Record your plain explanation of a letter, bill, notice, contract or screenshot the user sent. " +
    "Call this first whenever the user sends a document, before drafting any reply. Write every field in the user's language (English or Pidgin).",
  sensitive: false,
  schema: z.object({
    what_it_is: z.string().min(1).max(300).describe("What the document is and who sent it."),
    what_they_want: z.string().min(1).max(400).describe("What the sender is asking for or telling the user."),
    amount: z.string().max(120).optional().describe("Any money involved, as written."),
    deadline: z.string().max(120).optional().describe("Any date the user must act by."),
    watch_out: z.string().max(300).optional().describe("Penalties, risks or anything unusual worth knowing."),
  }),
  async run(args) {
    const text = [
      line("What it is", args.what_it_is),
      line("What they want", args.what_they_want),
      line("Amount", args.amount),
      line("Deadline", args.deadline),
      line("Watch out", args.watch_out),
    ]
      .filter(Boolean)
      .join("\n");
    return { message: "Explanation recorded and will be shown to the user.", showUser: text };
  },
});
