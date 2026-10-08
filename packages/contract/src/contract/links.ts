import * as v from "valibot";

import { query } from "./base";

const HttpUrl = v.pipe(
  v.string(),
  v.maxLength(4096),
  v.url(),
  v.check((s) => /^https?:\/\//i.test(s))
);
const Image = v.pipe(
  v.string(),
  v.maxLength(100_000),
  v.check((s) => /^data:image\/(png|jpeg|webp);base64,/.test(s))
);
export const LinkPreviewSchema = v.object({
  url: HttpUrl,
  finalUrl: HttpUrl,
  siteName: v.pipe(v.string(), v.maxLength(100)),
  title: v.pipe(v.string(), v.maxLength(90)),
  description: v.pipe(v.string(), v.maxLength(160)),
  imageDataUri: v.optional(Image),
  faviconDataUri: v.optional(Image),
});
export type LinkPreview = v.InferOutput<typeof LinkPreviewSchema>;
export const links = {
  preview: query
    .input(v.object({ url: HttpUrl }))
    .output(v.nullable(LinkPreviewSchema)),
};

export const previewTarget = (input: string): boolean => {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return (
      /^https?:$/.test(url.protocol) &&
      !url.username &&
      !url.password &&
      !/^(?:localhost$|local$|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[(?:::|fc|fd|fe[89ab]|ff))/i.test(
        host
      ) &&
      !/\.(?:local|localhost)$/.test(host) &&
      host !== "raw.githubusercontent.com" &&
      !/\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|pdf|zip|tar|gz|bz2|xz|7z|rar|dmg|exe|mp[34]|mov|csv|json|txt|xml)(?:\/)?$/i.test(
        url.pathname
      ) &&
      !/(?:^|\/)(?:login|log-in|signin|sign-in|signup|sign-up|auth|oauth|raw)(?:\/|$)/i.test(
        url.pathname
      )
    );
  } catch {
    return false;
  }
};
