import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";

const execFileAsync = promisify(execFile);

async function run(bin: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(bin, args, { maxBuffer: 10 * 1024 * 1024 });
  } catch (err: any) {
    throw new Error(`ffmpeg failed (exit ${err.code}): ${String(err.stderr ?? "").trim().slice(-500) || err.message}`);
  }
}

// FFMPEG_PATH wins, then the bundled binary, then whatever ffmpeg is on PATH.
const bundled = ffmpegStatic as unknown as string | null;
const ffmpegPath = process.env.FFMPEG_PATH || (bundled && existsSync(bundled) ? bundled : "ffmpeg");

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "mypaddy-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Voice note (usually OGG/Opus) to 24 kHz mono 16-bit WAV for Muse Voice Transcribe.
 * Without the leading pad and loudness normalisation the model often drops the first few words.
 */
export function toTranscriptionWav(input: Buffer): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const src = join(dir, "in");
    const dst = join(dir, "out.wav");
    await writeFile(src, input);
    await run(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", src,
      "-af", "adelay=600:all=1,apad=pad_dur=0.6,loudnorm",
      "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le",
      dst,
    ]);
    return readFile(dst);
  });
}

/**
 * Pulls one frame per second from a video and keeps the sharpest few, in time order.
 * JPEG size is a cheap stand-in for sharpness: blurred frames compress smaller.
 * Muse Spark reads fine print (NAFDAC numbers, batch codes) far more reliably from these than from the raw video.
 */
export function sharpestFrames(input: Buffer, count = 6): Promise<Buffer[]> {
  return withTempDir(async (dir) => {
    const src = join(dir, "in");
    await writeFile(src, input);
    await run(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", src,
      "-vf", "fps=1,scale='min(1920,iw)':-2",
      "-frames:v", "60",
      "-q:v", "2",
      join(dir, "f-%03d.jpg"),
    ]);
    const names = (await readdir(dir)).filter((n) => n.startsWith("f-"));
    const sized = await Promise.all(names.map(async (n) => ({ n, size: (await stat(join(dir, n))).size })));
    const picked = sized
      .sort((a, b) => b.size - a.size)
      .slice(0, count)
      .map((f) => f.n)
      .sort();
    return Promise.all(picked.map((n) => readFile(join(dir, n))));
  });
}

/** Width and height of a JPEG, read from its frame header. */
export function jpegSize(jpeg: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) return null;
    const marker = jpeg[i + 1];
    const length = jpeg.readUInt16BE(i + 2);
    // SOF0 to SOF15 carry the size, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

/** Runs one ffmpeg filter over a still image and returns the JPEG. */
function filterImage(input: Buffer, filter: string): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const src = join(dir, "in");
    const dst = join(dir, "out.jpg");
    await writeFile(src, input);
    await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vf", filter, "-frames:v", "1", "-q:v", "3", dst]);
    return readFile(dst);
  });
}

/** Shrinks a photo to at most this width, as a JPEG. Small photos are only re-encoded. */
export const scaleImage = (input: Buffer, maxWidth = 1280) => filterImage(input, `scale='min(${maxWidth},iw)':-2`);

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const cropImage = (input: Buffer, r: Rect) => filterImage(input, `crop=${r.w}:${r.h}:${r.x}:${r.y}`);

/** Draws rectangles on a photo, for example around the number MyPaddy read. */
export function drawBoxes(input: Buffer, boxes: (Rect & { color: string; thickness: number })[]): Promise<Buffer> {
  const filter = boxes.map((b) => `drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=${b.color}:t=${b.thickness}`).join(",");
  return filterImage(input, filter);
}
