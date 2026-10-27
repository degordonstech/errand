import type OpenAI from "openai";
import { config } from "../config.js";
import { sharpestFrames } from "../media/ffmpeg.js";
import { meta, retryModelNotFound, SPARK_MAX_TOKENS } from "./client.js";

type Part = OpenAI.Chat.Completions.ChatCompletionContentPart;

export function imagePart(data: Buffer, mimeType: string): Part {
  return { type: "image_url", image_url: { url: `data:${mimeType};base64,${data.toString("base64")}` } };
}

export function pdfPart(data: Buffer, filename = "document.pdf"): Part {
  return { type: "file", file: { filename, file_data: `data:application/pdf;base64,${data.toString("base64")}` } };
}

/** Video goes in as its sharpest frames, which read fine print better than the raw clip. */
export async function videoParts(data: Buffer): Promise<Part[]> {
  const frames = await sharpestFrames(data);
  return frames.map((f) => imagePart(f, "image/jpeg"));
}

/** One-shot question about media. */
export async function askAboutMedia(prompt: string, parts: Part[]): Promise<string> {
  const res = await retryModelNotFound(() =>
    meta.chat.completions.create({
      model: config.MUSE_SPARK_MODEL,
      max_tokens: SPARK_MAX_TOKENS,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...parts] }],
    }),
  );
  return res.choices[0]?.message?.content?.trim() ?? "";
}
