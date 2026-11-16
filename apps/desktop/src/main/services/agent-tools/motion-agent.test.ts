/**
 * What the renderer must refuse or rename, needing no window: a file name
 * Windows will not create, and a "logo" that is not an image it may embed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {} }));
vi.mock("#main/resources", () => ({ resourcePath: () => "/nowhere" }));

import { fileBase, readMotionImage } from "./motion-agent";

describe("a video's file name", () => {
  it("is a slug of the name, else the template's, and never one Windows refuses", () => {
    expect(fileBase("Quarterly Sales — 2026!", "chart")).toBe(
      "quarterly-sales-2026"
    );
    expect(fileBase("बोर्ड परीक्षा", "title-card")).toBe("title-card");
    expect(fileBase("CON", "title-card")).toBe("con-video");
    expect(fileBase("console", "title-card")).toBe("console");
  });
});

describe("an image for a template (a logo)", () => {
  it("is refused when missing, not an image by its bytes, or too large", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "motion-image-"));
    const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    fs.writeFileSync(path.join(dir, "notes.png"), "just text");
    fs.writeFileSync(
      path.join(dir, "huge.png"),
      Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)])
    );
    expect(() => readMotionImage("gone.png", { cwd: dir })).toThrow(
      /There is no file at .*gone\.png\./
    );
    expect(() => readMotionImage("notes.png", { cwd: dir })).toThrow(
      /notes\.png is not a PNG, JPEG, WebP, GIF or SVG image\./
    );
    expect(() => readMotionImage("huge.png", { cwd: dir })).toThrow(
      /is 9 MB; use an image under 8 MB\./
    );
  });
});
