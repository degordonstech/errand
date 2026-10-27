import { findInImage, type SamBox } from "../ai/sam.js";
import { askAboutMedia, imagePart } from "../ai/vision.js";
import { cropImage, drawBoxes, jpegSize, scaleImage, type Rect } from "../media/ffmpeg.js";

/**
 * Shows the user exactly what was checked: their photo with the pack outlined and the
 * NAFDAC number boxed. Segment Anything 3.1 finds the pack; Muse Spark then reads the
 * number from a close crop of just the pack and says where it is.
 */
export interface MarkedPack {
  image: Buffer;
  /** The number as read from the close crop, to compare with the first reading. */
  numberRead: string | null;
}

const pad = (r: SamBox, by: number, w: number, h: number): Rect => {
  const x = Math.max(0, Math.floor(r.x1 - by));
  const y = Math.max(0, Math.floor(r.y1 - by));
  return { x, y, w: Math.min(w, Math.ceil(r.x2 + by)) - x, h: Math.min(h, Math.ceil(r.y2 + by)) - y };
};

/** Pulls {"nafdac_number": "...", "box": [x1, y1, x2, y2]} out of the model's reply. */
export function parseLocation(text: string): { number: string | null; box: [number, number, number, number] | null } {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return { number: null, box: null };
  try {
    const v = JSON.parse(json) as { nafdac_number?: unknown; box?: unknown };
    const box = Array.isArray(v.box) && v.box.length === 4 && v.box.every((n) => typeof n === "number" && n >= 0 && n <= 1000) ? (v.box as [number, number, number, number]) : null;
    return { number: typeof v.nafdac_number === "string" && v.nafdac_number.trim() ? v.nafdac_number.trim() : null, box };
  } catch {
    return { number: null, box: null };
  }
}

const LOCATE_PROMPT =
  'Find the NAFDAC registration number printed on this pack. Reply with JSON only: {"nafdac_number": "...", "box": [x1, y1, x2, y2]} ' +
  "where box is the rectangle around the number itself, in coordinates normalised to 0-1000 on both axes (0,0 is the top left). " +
  'If there is no NAFDAC number, reply {"nafdac_number": null, "box": null}.';

export async function markPack(photo: Buffer): Promise<MarkedPack | null> {
  const image = await scaleImage(photo);
  const size = jpegSize(image);
  if (!size) return null;

  const pack = (await findInImage(image, "package").catch(() => []))[0];
  const area: Rect = pack ? pad(pack, 20, size.width, size.height) : { x: 0, y: 0, w: size.width, h: size.height };
  const crop = pack ? await cropImage(image, area) : image;

  const { number, box } = parseLocation(await askAboutMedia(LOCATE_PROMPT, [imagePart(crop, "image/jpeg")]));
  if (!box) return null;

  // Back from the crop's 0-1000 scale to the photo's pixels, with a little room around the text.
  const margin = Math.round(size.width / 100);
  const x1 = area.x + (box[0] / 1000) * area.w - margin;
  const y1 = area.y + (box[1] / 1000) * area.h - margin;
  const x2 = area.x + (box[2] / 1000) * area.w + margin;
  const y2 = area.y + (box[3] / 1000) * area.h + margin;
  const numberBox = pad({ x1, y1, x2, y2 }, 0, size.width, size.height);
  if (numberBox.w < 4 || numberBox.h < 4) return null;

  const thick = Math.max(3, Math.round(size.width / 300));
  const boxes = [{ ...numberBox, color: "red@0.95", thickness: thick }];
  if (pack) boxes.unshift({ ...pad(pack, 0, size.width, size.height), color: "lime@0.8", thickness: Math.max(2, thick - 1) });
  return { image: await drawBoxes(image, boxes), numberRead: number };
}
