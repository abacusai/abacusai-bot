import {
  previewTarget,
  type LinkPreview,
} from "@abacus-ai/contract/contract/links";
import {
  PhotonImage,
  crop,
  resize,
  SamplingFilter,
} from "@silvia-odwyer/photon-node";
import { imageSize } from "image-size";

import { PreviewClient, previewUrl } from "./client";
import { previewMetadata } from "./parser";

type FetchResource = PreviewClient["fetch"];
const defaultClient = new PreviewClient();

export class LinkPreviews {
  private readonly cache = new Map<
    string,
    { value: LinkPreview | null; expires: number }
  >();
  private readonly pending = new Map<string, Promise<LinkPreview | null>>();
  private readonly hosts = new Map<string, { at: number; count: number }>();
  private active = 0;
  constructor(
    private readonly fetch: FetchResource = defaultClient.fetch.bind(
      defaultClient
    ),
    private readonly now = Date.now
  ) {}

  get(input: string): Promise<LinkPreview | null> {
    if (!previewTarget(input)) return Promise.resolve(null);
    let url: URL;
    try {
      url = previewUrl(input);
    } catch {
      return Promise.resolve(null);
    }
    const key = url.href;
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached.value);
    }
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const budget = this.hosts.get(url.hostname);
    const count = budget && this.now() - budget.at < 60_000 ? budget.count : 0;
    // Reject excess demand without queueing an unbounded history workload.
    if (this.active >= 4 || count >= 12) return Promise.resolve(null);
    this.hosts.delete(url.hostname);
    this.hosts.set(url.hostname, {
      at: count ? budget!.at : this.now(),
      count: count + 1,
    });
    while (this.hosts.size > 200)
      this.hosts.delete(this.hosts.keys().next().value!);
    this.active++;
    const work = this.load(key)
      .then((value) => {
        this.cache.delete(key);
        this.cache.set(key, {
          value,
          expires: this.now() + (value ? 3_600_000 : 600_000),
        });
        while (this.cache.size > 200)
          this.cache.delete(this.cache.keys().next().value!);
        return value;
      })
      .finally(() => {
        this.active--;
        this.pending.delete(key);
      });
    this.pending.set(key, work);
    return work;
  }

  private async load(url: string): Promise<LinkPreview | null> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Preview timeout")),
      5000
    );
    const signal = controller.signal;
    const timeout = new Promise<never>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      })
    );
    try {
      return await Promise.race([this.read(url, signal), timeout]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async read(
    url: string,
    signal: AbortSignal
  ): Promise<LinkPreview | null> {
    const resource = await this.fetch(url, "html", signal);
    const { image, favicon, ...metadata } = previewMetadata(
      resource.body.toString("utf8"),
      resource.url
    );
    if (
      !previewTarget(resource.url) ||
      !metadata.title ||
      /^(?:404|403|not found|page not found|access denied|forbidden|sign[ -]?in|log[ -]?in)(?:\b|$)/i.test(
        metadata.title
      )
    )
      return null;
    const imageData = async (
      source: string | undefined,
      size: number,
      aspect = 1
    ) => {
      if (!source) return undefined;
      try {
        const response = await this.fetch(source, "image", signal);
        // SVG and animated formats never reach the renderer. Limit decoded
        // pixels as well as download bytes, then strip metadata on encoding.
        const info = imageSize(response.body);
        if (
          !["png", "jpg", "webp"].includes(info.type ?? "") ||
          !info.width ||
          !info.height ||
          info.width * info.height > 4_000_000
        )
          return undefined;
        const original = PhotonImage.new_from_byteslice(response.body);
        let cropped: PhotonImage | undefined;
        let scaled: PhotonImage | undefined;
        let bytes: Buffer;
        try {
          const width = Math.min(info.width, Math.floor(info.height * aspect));
          const height = Math.min(info.height, Math.floor(info.width / aspect));
          const x = Math.floor((info.width - width) / 2);
          const y = Math.floor((info.height - height) / 2);
          cropped = crop(original, x, y, x + width, y + height);
          const target = Math.min(size, width);
          scaled = resize(
            cropped,
            target,
            Math.max(1, Math.floor(target / aspect)),
            SamplingFilter.Lanczos3
          );
          bytes = Buffer.from(scaled.get_bytes());
        } finally {
          scaled?.free();
          cropped?.free();
          original.free();
        }
        signal.throwIfAborted();
        return bytes.length <= 60_000
          ? `data:image/png;base64,${bytes.toString("base64")}`
          : undefined;
      } catch {
        return undefined;
      }
    };
    const [imageDataUri, faviconDataUri] = await Promise.all([
      imageData(image, 320, 16 / 9),
      imageData(favicon, 20),
    ]);
    return {
      url,
      finalUrl: resource.url,
      ...metadata,
      ...(imageDataUri ? { imageDataUri } : {}),
      ...(faviconDataUri ? { faviconDataUri } : {}),
    };
  }
}
