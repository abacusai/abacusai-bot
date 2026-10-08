import * as v from "valibot";
import { expect, it } from "vitest";

import { PrefsPatchSchema } from "./db";
import { LinkPreviewSchema } from "./links";
it("validates preview replies and rejects third-party image URLs", () => {
  const value = {
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    siteName: "Example",
    title: "Title",
    description: "",
  };
  expect(v.safeParse(LinkPreviewSchema, value).success).toBe(true);
  expect(
    v.safeParse(LinkPreviewSchema, {
      ...value,
      imageDataUri: "https://example.com/image.png",
    }).success
  ).toBe(false);
  expect(
    v.safeParse(LinkPreviewSchema, { ...value, url: "file:///tmp/x" }).success
  ).toBe(false);
});
it("accepts the persisted preview setting and refuses nonbooleans", () => {
  expect(v.parse(PrefsPatchSchema, { showLinkPreviews: false })).toEqual({
    showLinkPreviews: false,
  });
  expect(
    v.safeParse(PrefsPatchSchema, { showLinkPreviews: "true" }).success
  ).toBe(false);
});
