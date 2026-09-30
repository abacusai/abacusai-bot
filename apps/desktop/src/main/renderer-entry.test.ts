/** R1-T17: the entry for each base × generation, and the dev content size gate. */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  devContentSize,
  experienceEntryUrl,
  rendererEntry,
  type RendererBase,
} from "./renderer-entry";

const bases: Record<string, RendererBase> = {
  dev: { kind: "dev", url: "http://localhost:5173/" },
  experience: {
    kind: "experience",
    url: new URL(`app://bundle.${"a".repeat(32)}.${"b".repeat(32)}/`),
  },
  file: { kind: "file", directory: "/app/dist/renderer" },
};

describe("rendererEntry", () => {
  it("keeps the legacy URLs exactly as they were", () => {
    expect(rendererEntry(bases.dev!, "legacy")).toEqual({
      kind: "url",
      url: "http://localhost:5173/",
    });
    expect(rendererEntry(bases.experience!, "legacy")).toEqual({
      kind: "url",
      url: `app://bundle.${"a".repeat(32)}.${"b".repeat(32)}/`,
    });
    expect(rendererEntry(bases.file!, "legacy")).toEqual({
      kind: "file",
      path: join("/app/dist/renderer", "index.html"),
    });
  });

  it("loads index-next.html for wco", () => {
    expect(rendererEntry(bases.dev!, "wco")).toEqual({
      kind: "url",
      url: "http://localhost:5173/index-next.html",
    });
    expect(rendererEntry(bases.experience!, "wco")).toEqual({
      kind: "url",
      url: `app://bundle.${"a".repeat(32)}.${"b".repeat(32)}/index-next.html`,
    });
    expect(rendererEntry(bases.file!, "wco")).toEqual({
      kind: "file",
      path: join("/app/dist/renderer", "index-next.html"),
    });
  });

  it("points an experience swap at the generation's document", () => {
    const url = new URL("app://bundle.x/");
    expect(experienceEntryUrl(url, "legacy")).toBe(url);
    expect(experienceEntryUrl(url, "wco")?.href).toBe(
      "app://bundle.x/index-next.html"
    );
    expect(experienceEntryUrl(null, "wco")).toBeNull();
  });
});

describe("devContentSize", () => {
  it("parses WxH when unpackaged", () => {
    expect(
      devContentSize({ ABACUSBOT_DEV_CONTENT_SIZE: "1280x800" }, false)
    ).toEqual({ width: 1280, height: 800 });
  });

  it("is ignored when packaged or malformed", () => {
    expect(
      devContentSize({ ABACUSBOT_DEV_CONTENT_SIZE: "1280x800" }, true)
    ).toBeNull();
    expect(
      devContentSize({ ABACUSBOT_DEV_CONTENT_SIZE: "wide" }, false)
    ).toBeNull();
    expect(devContentSize({}, false)).toBeNull();
  });
});
