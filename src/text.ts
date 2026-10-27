/**
 * Tidies model output for chat: *bold* instead of Markdown,
 * no headings, no emoji, no long dashes.
 */
export function cleanReply(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\s*—\s*/g, ", ")
    .replace(/(\d)\s*–\s*(\d)/g, "$1-$2")
    .replace(/\s*–\s*/g, ", ")
    // A spaced hyphen between words is a dash in disguise. List bullets and ranges are left alone.
    .replace(/(?<=[A-Za-z)*.!?]) - (?=[A-Za-z(*])/g, ", ")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
