import { config } from "../config.js";
import { fetchRetry } from "../net.js";
import { metaHeaders } from "./client.js";

export interface SamBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Reads boxes out of SAM's output, "<0f>0<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|><|mask;...|>". */
export function parseSamBoxes(text: string): SamBox[] {
  return [...text.matchAll(/<\|box;([^|]*)\|>/g)].map((m) => {
    const v = Object.fromEntries(m[1].split(";").map((kv) => kv.split("=")).map(([k, n]) => [k, Number(n)]));
    return { x1: v.x1, y1: v.y1, x2: v.x2, y2: v.y2 };
  });
}

/**
 * Finds every instance of a concept ("package", "barcode") in a photo with Segment Anything 3.1.
 * Coordinates are in the photo's own pixels. An empty list is a normal answer, not an error.
 */
export async function findInImage(jpeg: Buffer, concept: string): Promise<SamBox[]> {
  const res = await fetchRetry(`${config.META_API_BASE_URL}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.META_API_KEY}`, "Content-Type": "application/json", ...metaHeaders() },
    body: JSON.stringify({
      model: "sam-3.1",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: concept },
            { type: "input_image", image_url: `data:image/jpeg;base64,${jpeg.toString("base64")}` },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`SAM request failed: HTTP ${res.status}`);
  const body = (await res.json()) as { output?: { content?: { text?: string }[] }[] };
  const text = (body.output ?? []).flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join("");
  return parseSamBoxes(text);
}
