import * as v from "valibot";

import { query } from "./base";

const HttpUrl = v.pipe(
  v.string(),
  v.maxLength(4096),
  v.url(),
  v.check((s) => /^https?:\/\//i.test(s))
);
const Text = v.pipe(v.string(), v.maxLength(600));
const Image = v.pipe(
  v.string(),
  v.maxLength(100_000),
  v.check((s) => /^data:image\/(png|jpeg|webp);base64,/.test(s))
);
export const LinkPreviewSchema = v.object({
  url: HttpUrl,
  finalUrl: HttpUrl,
  siteName: Text,
  title: Text,
  description: Text,
  imageDataUri: v.optional(Image),
  faviconDataUri: v.optional(Image),
});
export type LinkPreview = v.InferOutput<typeof LinkPreviewSchema>;
export const links = {
  preview: query
    .input(v.object({ url: HttpUrl }))
    .output(v.nullable(LinkPreviewSchema)),
};
