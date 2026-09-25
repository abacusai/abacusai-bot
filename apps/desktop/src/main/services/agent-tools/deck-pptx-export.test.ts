/**
 * The editable deck went missing, run after run, with nothing to show for it.
 *
 * `deck-stage` scales the deck to fit the window and keeps non-active slides
 * hidden. Its own docs say the PPTX exporter sets `noscale` so the capture sees
 * real geometry. Nothing did, so every slide measured 0x0. The export then
 * failed into a `console.error` and a null, which the tool turned into an
 * omitted line: the user got a PDF, no .pptx, and no reason.
 */
import { describe, expect, it } from "vitest";

import { isSupportedImage, unmeasurableSlides } from "./deck-pptx-export";

const slide = (
  width: number,
  height: number
): { width: number; height: number } => ({
  width,
  height,
});

describe("deciding whether the page was measurable", () => {
  it("rejects a capture where every slide measured nothing", () => {
    // What a scaled, hidden stage actually produced.
    expect(unmeasurableSlides([slide(0, 0), slide(0, 0), slide(0, 0)])).toBe(
      true
    );
  });

  it("rejects an empty capture", () => {
    expect(unmeasurableSlides([])).toBe(true);
  });

  it("accepts a real deck", () => {
    expect(unmeasurableSlides([slide(1920, 1080), slide(1920, 1080)])).toBe(
      false
    );
  });

  it("accepts a deck where only one slide came back empty", () => {
    // One odd slide is the template's business; every slide empty is ours.
    expect(unmeasurableSlides([slide(1920, 1080), slide(0, 0)])).toBe(false);
  });
});

/**
 * The export sizes images through pptxgenjs, which sizes them through
 * `image-size`, whose ICNS, JXL and HEIF parsers loop forever on a crafted
 * buffer (CVE-2025-71329, CVE-2025-71330), in the main process, so the whole
 * app stops. No fixed release exists, so the buffers never reach it.
 */
describe("which captured images are safe to size", () => {
  const uri = (mediaType: string, bytes: number[]): string =>
    `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;

  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];
  const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
  const GIF = [...Buffer.from("GIF89a; and then some")];
  const WEBP = [...Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ")];
  const ICNS = [...Buffer.from("icns\u0000\u0000\u0000\u0010")];
  const HEIF = [...Buffer.from("\u0000\u0000\u0000\u0018ftypheic")];
  const JXL = [0xff, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

  it("passes the formats a deck actually uses", () => {
    expect(isSupportedImage(uri("image/png", PNG))).toBe(true);
    expect(isSupportedImage(uri("image/jpeg", JPEG))).toBe(true);
    expect(isSupportedImage(uri("image/gif", GIF))).toBe(true);
    expect(isSupportedImage(uri("image/webp", WEBP))).toBe(true);
  });

  it("passes SVG, which is text and reaches no binary parser", () => {
    expect(isSupportedImage("data:image/svg+xml,%3Csvg%20/%3E")).toBe(true);
  });

  it("drops the formats with the hanging parsers", () => {
    expect(isSupportedImage(uri("image/icns", ICNS))).toBe(false);
    expect(isSupportedImage(uri("image/heif", HEIF))).toBe(false);
    expect(isSupportedImage(uri("image/jxl", JXL))).toBe(false);
  });

  it("goes by the bytes, not by what the URI calls itself", () => {
    // The whole reason this checks signatures: the media type is written by
    // whoever produced the image, and image-size never reads it.
    expect(isSupportedImage(uri("image/png", ICNS))).toBe(false);
    expect(isSupportedImage(uri("image/jpeg", HEIF))).toBe(false);
  });

  it("drops a RIFF container that is not WebP", () => {
    const avi = [...Buffer.from("RIFF\u0000\u0000\u0000\u0000AVI LIST")];

    expect(isSupportedImage(uri("image/webp", avi))).toBe(false);
  });

  it("drops anything it cannot recognise, rather than passing it on", () => {
    expect(isSupportedImage("")).toBe(false);
    expect(isSupportedImage("https://example.com/a.png")).toBe(false);
    expect(isSupportedImage("data:image/png,not-base64-at-all")).toBe(false);
    expect(isSupportedImage(uri("image/png", [0x00, 0x01, 0x02]))).toBe(false);
  });
});
