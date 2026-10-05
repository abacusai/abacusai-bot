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
  it("loads index.html for wco", () => {
    expect(rendererEntry(bases.dev!)).toEqual({
      kind: "url",
      url: "http://localhost:5173/index.html",
    });
    expect(rendererEntry(bases.experience!)).toEqual({
      kind: "url",
      url: `app://bundle.${"a".repeat(32)}.${"b".repeat(32)}/index.html`,
    });
    expect(rendererEntry(bases.file!)).toEqual({
      kind: "file",
      path: join("/app/dist/renderer", "index.html"),
    });
  });

  it("points an experience swap at the generation's document", () => {
    const url = new URL("app://bundle.x/");
    expect(experienceEntryUrl(url)?.href).toBe("app://bundle.x/index.html");
    expect(experienceEntryUrl(null)).toBeNull();
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
