import { describe, expect, it } from "vitest";
import { parseSamBoxes } from "../src/ai/sam.js";
import { jpegSize } from "../src/media/ffmpeg.js";
import { parseLocation } from "../src/product/mark.js";

describe("reading model output for the marked pack photo", () => {
  it("reads SAM boxes", () => {
    const out = "<0f>0<|box;x1=241;y1=761;x2=646;y2=1535;w=1280;h=1706|><|mask;x=0;y=0;data=1,2,~|>,1<|box;x1=1;y1=2;x2=3;y2=4;w=1280;h=1706|>";
    expect(parseSamBoxes(out)).toEqual([
      { x1: 241, y1: 761, x2: 646, y2: 1535 },
      { x1: 1, y1: 2, x2: 3, y2: 4 },
    ]);
    expect(parseSamBoxes("")).toEqual([]);
  });

  it("reads the number location, and refuses boxes outside 0-1000", () => {
    expect(parseLocation('Here: {"nafdac_number": "04-2467", "box": [540, 378, 840, 412]}')).toEqual({ number: "04-2467", box: [540, 378, 840, 412] });
    expect(parseLocation('{"nafdac_number": null, "box": null}')).toEqual({ number: null, box: null });
    expect(parseLocation('{"nafdac_number": "04-2467", "box": [540, 378, 1840, 412]}').box).toBeNull();
    expect(parseLocation("no json here")).toEqual({ number: null, box: null });
  });

  it("reads a JPEG's size from its header", () => {
    // Smallest valid header: SOI, then a baseline SOF0 segment for a 640 x 480 image.
    const sof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(jpegSize(sof)).toEqual({ width: 640, height: 480 });
    expect(jpegSize(Buffer.from("not a jpeg"))).toBeNull();
  });
});
