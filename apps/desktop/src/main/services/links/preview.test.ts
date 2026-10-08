import { describe, expect, it, vi, afterEach } from "vitest";

import { PreviewClient, previewUrl, publicAddress } from "./client";
import { previewMetadata } from "./parser";
import { LinkPreviews } from "./preview";

afterEach(() => vi.useRealTimers());
describe("preview targets", () => {
  it.each([
    "0.0.0.0",
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
  ])("blocks %s", (ip) => expect(publicAddress(ip)).toBe(false));
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("permits %s", (ip) =>
    expect(publicAddress(ip)).toBe(true)
  );
  it.each([
    "http://localhost",
    "https://x.local/a",
    "http://x.localhost",
    "http://127.1",
    "http://0177.0.0.1",
    "http://0x7f000001",
    "http://2130706433",
    "http://[::1]",
    "http://[::ffff:127.0.0.1]",
    "http://user:password@example.com",
    "http://example.com:8080",
    "file:///tmp/x",
  ])("refuses %s", (url) => expect(() => previewUrl(url)).toThrow());
  it("accepts standard ports and drops fragments", () =>
    expect(previewUrl("https://example.com:443/a#b").href).toBe(
      "https://example.com/a"
    ));
  it("rejects a mixed public/private DNS answer before connecting", async () => {
    const resolve = vi.fn().mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(
      new PreviewClient(resolve).fetch(
        "https://example.com",
        "html",
        new AbortController().signal
      )
    ).rejects.toThrow("DNS");
  });
});
describe("head metadata", () => {
  it("decodes entities, quoted > and relative images; ignores body metadata", () => {
    const result = previewMetadata(
      '<head><title>Fallback</title><META PROPERTY="og:title" content="A &amp; B > C"><meta property="og:description" content="  Nice\n site  "><link rel="shortcut icon" href="/icon.png"><meta property="og:image" content="../cover.png"></head><body><meta property="og:title" content="Wrong"></body>',
      "https://example.com/docs/a"
    );
    expect(result).toMatchObject({
      title: "A & B > C",
      description: "Nice site",
      image: "https://example.com/cover.png",
      favicon: "https://example.com/icon.png",
    });
  });
  it("uses Twitter and title fallbacks and truncates hostile metadata", () => {
    expect(
      previewMetadata(
        '<head><meta name="twitter:title" content="Twitter"><meta property="og:image" content="javascript:alert(1)"></head>',
        "https://example.com"
      ).title
    ).toBe("Twitter");
    const metadata = previewMetadata(
      `<title>${"x".repeat(1000)}</title><meta name="description" content="hi&#x202e;there">`,
      "https://example.com"
    );
    expect(metadata.title).toHaveLength(90);
    expect(metadata.description).toBe("hi there");
    expect(metadata.image).toBeUndefined();
  });
});
describe("preview budget and cache", () => {
  const resource = {
    body: Buffer.from("<title>Example</title>"),
    url: "https://example.com/",
    type: "text/html",
  };
  it("deduplicates in flight and caches successes for an hour", async () => {
    let now = 0;
    const fetch = vi.fn().mockResolvedValue(resource);
    const previews = new LinkPreviews(fetch, () => now);
    await Promise.all([previews.get(resource.url), previews.get(resource.url)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await previews.get(resource.url);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 3_600_001;
    await previews.get(resource.url);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("negative caches failures for ten minutes", async () => {
    let now = 0;
    const fetch = vi.fn().mockRejectedValue(new Error("no"));
    const previews = new LinkPreviews(fetch, () => now);
    expect(await previews.get(resource.url)).toBeNull();
    await previews.get(resource.url);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 600_001;
    await previews.get(resource.url);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("returns within five seconds even when DNS stalls", async () => {
    vi.useFakeTimers();
    const previews = new LinkPreviews(() => new Promise(() => {}));
    const promise = previews.get(resource.url);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await promise).toBeNull();
  });
  it("caps concurrent work and requests per host", async () => {
    const fetch = vi.fn().mockImplementation(async () => resource);
    const previews = new LinkPreviews(fetch);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        previews.get(`https://example.com/${i}`)
      )
    );
    expect(fetch).toHaveBeenCalledTimes(4);
    for (let i = 20; i < 40; i++)
      await previews.get(`https://example.com/${i}`);
    expect(fetch).toHaveBeenCalledTimes(12);
  });
});

it("evicts least recently used entries at 200 URLs", async () => {
  const fetch = vi.fn(async (url: string) => ({
    body: Buffer.from("<title>Example</title>"),
    url,
    type: "text/html",
  }));
  const cache = new LinkPreviews(fetch);
  for (let i = 0; i < 200; i++) await cache.get(`https://h${i}.example.com/`);
  await cache.get("https://h0.example.com/");
  await cache.get("https://h200.example.com/");
  await cache.get("https://h0.example.com/");
  expect(fetch).toHaveBeenCalledTimes(201);
  await cache.get("https://h1.example.com/");
  expect(fetch).toHaveBeenCalledTimes(202);
});
it("fetches relative images through the guarded client and re-encodes small data URIs", async () => {
  const { PhotonImage } = await import("@silvia-odwyer/photon-node");
  const image = new PhotonImage(
    new Uint8Array(100 * 100 * 4).fill(128),
    100,
    100
  );
  const body = Buffer.from(image.get_bytes());
  image.free();
  const fetch = vi.fn(async (url: string, kind: string) =>
    kind === "html"
      ? {
          body: Buffer.from(
            '<title>Example</title><meta property="og:image" content="/image.png"><link rel="icon" href="/icon.png">'
          ),
          url,
          type: "text/html",
        }
      : { body, url, type: "image/png" }
  );
  const result = await new LinkPreviews(fetch).get("https://example.com/");
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://example.com/",
    "https://example.com/image.png",
    "https://example.com/icon.png",
  ]);
  expect(result?.imageDataUri).toMatch(/^data:image\/png;base64,/);
  const { imageSize } = await import("image-size");
  expect(
    imageSize(Buffer.from(result!.imageDataUri!.split(",")[1]!, "base64"))
  ).toMatchObject({ width: 100, height: 56 });
  expect(
    imageSize(Buffer.from(result!.faviconDataUri!.split(",")[1]!, "base64"))
  ).toMatchObject({ width: 20, height: 20 });
});

it("skips login walls, direct files and generic error titles", async () => {
  const fetch = vi.fn(async (url: string) => ({
    body: Buffer.from("<title>404 Not Found</title>"),
    url,
    type: "text/html",
  }));
  const cache = new LinkPreviews(fetch);
  for (const url of [
    "https://example.com/login",
    "https://example.com/file.pdf",
    "https://example.com/photo.png",
    "https://example.com/archive.zip",
  ])
    expect(await cache.get(url)).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(await cache.get("https://example.com/missing")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("caps the title and description before returning metadata", () => {
  const result = previewMetadata(
    `<title>${"t".repeat(100)}</title><meta name="description" content="${"d".repeat(200)}">`,
    "https://example.com/"
  );
  expect(result.title).toHaveLength(90);
  expect(result.description).toHaveLength(160);
});
