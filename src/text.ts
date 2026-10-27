/**
 * Tidies model output for WhatsApp: WhatsApp bold instead of Markdown,
 * no headings, no emoji, no long dashes.
 */
export function cleanReply(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\s*—\s*/g, ", ")
    .replace(/(\d)\s*–\s*(\d)/g, "$1-$2")
    .replace(/\s*–\s*/g, ", ")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
