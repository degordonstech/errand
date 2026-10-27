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

export const reviewAgreement = defineTool({
  name: "review_agreement",
  description:
    "Record your plain review of a contract, tenancy agreement, offer letter, loan form or terms the user is about to sign. " +
    "Use it instead of explain_document for anything they would sign. Write every field in the user's language.",
  sensitive: false,
  schema: z.object({
    what_it_is: z.string().min(1).max(300).describe("What it is, between whom."),
    key_terms: z.string().min(1).max(800).describe("Money, length, notice period, renewal, what each side must do. Short lines."),
    watch_out: z.string().min(1).max(800).describe("Clauses that are unusual, one-sided or costly: penalties, hidden fees, automatic renewal, forfeited deposits."),
    ask_before_signing: z.string().max(500).optional().describe("Questions worth asking the other side before signing."),
  }),
  async run(args) {
    const text = [
      line("What it is", args.what_it_is),
      line("Key terms", args.key_terms),
      line("Watch out", args.watch_out),
      line("Ask before you sign", args.ask_before_signing),
      "_This is a plain reading to help you, not legal advice. For anything big, talk to a lawyer._",
    ]
      .filter(Boolean)
      .join("\n\n");
    return { message: "Review recorded and will be shown to the user. Do not repeat it.", showUser: text };
  },
});
