import fs from "node:fs/promises";
/**
 * "A beautiful pdf with images" that printed none.
 *
 * The sub-agent wrote `<img src="https://upload.wikimedia.org/…">`, the
 * sanitizer deleted every one of them for not being a local file, and the
 * finished document was announced as image-rich. These cover the fetch that
 * makes those tags printable and, just as importantly, that anything unfetched
 * is reported rather than vanishing.
 *
 * Served from a real loopback server: the failure was about what a real
 * response does (its status, its content-type), which a stubbed fetch decides
 * for itself.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  localiseImages,
  remoteImageSources,
  rewriteImageSources,
} from "./document-images";

/** The tests serve from loopback, which the real guard refuses. See its own test below. */
const allowLoopback = (): void => undefined;

// A one-pixel PNG, so content-type and bytes are both real.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const servers: http.Server[] = [];
const dirs: string[] = [];

const serve = async (
  routes: Record<string, { type?: string; body?: Buffer; status?: number }>
) => {
  const server = http.createServer((request, response) => {
    const route = routes[request.url ?? ""];
    if (route == null) {
      response.writeHead(404);
      return response.end("nope");
    }
    response.writeHead(
      route.status ?? 200,
      route.type != null ? { "Content-Type": route.type } : {}
    );
    response.end(route.body ?? Buffer.alloc(0));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const workdir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-img-"));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0))
    await new Promise<void>((r) => server.close(() => r()));
  for (const dir of dirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});

describe("finding the images a document wants", () => {
  it("picks up the shape the sub-agent actually wrote", () => {
    const html =
      '<p><img src="https://upload.wikimedia.org/wikipedia/commons/8/8b/Thali.jpg" alt="A thali" /></p>';

    expect(remoteImageSources([html])).toEqual([
      "https://upload.wikimedia.org/wikipedia/commons/8/8b/Thali.jpg",
    ]);
  });

  it("collects across sections and does not repeat one used twice", () => {
    const a = '<img src="https://example.com/a.jpg">';
    const b =
      "<img src='https://example.com/a.jpg'><img src=https://example.com/b.jpg>";

    expect(remoteImageSources([a, b])).toEqual([
      "https://example.com/a.jpg",
      "https://example.com/b.jpg",
    ]);
  });

  it("leaves local sources alone, since they already print", () => {
    expect(
      remoteImageSources([
        '<img src="chart.png"><img src="data:image/png;base64,AAA">',
      ])
    ).toEqual([]);
  });
});

describe("fetching them", () => {
  it("writes the image beside the document and points the tag at it", async () => {
    const origin = await serve({
      "/thali.png": { type: "image/png", body: PNG },
    });
    const dir = await workdir();
    const html = `<p><img src="${origin}/thali.png" alt="A thali"></p>`;

    const report = await localiseImages([html], dir, allowLoopback);

    expect(report.dropped).toEqual([]);
    expect(report.localised.size).toBe(1);

    const name = report.localised.get(`${origin}/thali.png`)!;
    expect(await fs.readFile(path.join(dir, name))).toEqual(PNG);

    const rewritten = rewriteImageSources(html, report.localised);
    expect(rewritten).toContain(`src="${name}"`);
    expect(rewritten).not.toContain("http://");
    // The rest of the tag survives, so alt text and captions are not lost.
    expect(rewritten).toContain('alt="A thali"');
  });

  it("writes one file when the same photo is used in several sections", async () => {
    const origin = await serve({ "/a.png": { type: "image/png", body: PNG } });
    const dir = await workdir();

    const report = await localiseImages(
      [`<img src="${origin}/a.png">`, `<img src="${origin}/a.png">`],
      dir,
      allowLoopback
    );

    expect(report.localised.size).toBe(1);
    expect((await fs.readdir(dir)).length).toBe(1);
  });

  it("reports a 404 instead of dropping it in silence", async () => {
    const origin = await serve({});
    const dir = await workdir();

    const report = await localiseImages(
      [`<img src="${origin}/missing.png">`],
      dir,
      allowLoopback
    );

    expect(report.localised.size).toBe(0);
    expect(report.dropped).toHaveLength(1);
    expect(report.dropped[0]).toContain("404");
  });

  it("refuses a response that is not an image, and says what it was", async () => {
    const origin = await serve({
      "/page": { type: "text/html", body: Buffer.from("<h1>hi</h1>") },
    });
    const dir = await workdir();

    const report = await localiseImages(
      [`<img src="${origin}/page">`],
      dir,
      allowLoopback
    );

    expect(report.dropped[0]).toContain("not an image");
    expect(report.dropped[0]).toContain("text/html");
  });

  it("keeps the good images when one of them fails", async () => {
    const origin = await serve({
      "/good.png": { type: "image/png", body: PNG },
    });
    const dir = await workdir();
    const html = `<img src="${origin}/good.png"><img src="${origin}/bad.png">`;

    const report = await localiseImages([html], dir, allowLoopback);

    expect(report.localised.size).toBe(1);
    expect(report.dropped).toHaveLength(1);
  });

  it("leaves an unfetched tag untouched, for the sanitizer to drop", async () => {
    const origin = await serve({});
    const dir = await workdir();
    const html = `<img src="${origin}/missing.png">`;

    const report = await localiseImages([html], dir, allowLoopback);

    expect(rewriteImageSources(html, report.localised)).toBe(html);
  });

  it("does nothing, and costs nothing, when there are no images", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const report = await localiseImages(
      ["<p>No pictures here.</p>"],
      await workdir()
    );

    expect(report.localised.size).toBe(0);
    expect(report.dropped).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("what it refuses to fetch", () => {
  it("will not be pointed at a private host", async () => {
    const dir = await workdir();

    const report = await localiseImages(
      ['<img src="http://169.254.169.254/latest/meta-data/">'],
      dir
    );

    expect(report.localised.size).toBe(0);
    expect(report.dropped[0]).toMatch(/private|loopback|non-https/i);
  });

  it("caps how many it will fetch, and says what it skipped", async () => {
    const origin = await serve({ "/a.png": { type: "image/png", body: PNG } });
    const dir = await workdir();
    const many = Array.from(
      { length: 45 },
      (_, i) => `<img src="${origin}/a.png?n=${i}">`
    ).join("");

    const report = await localiseImages([many], dir, allowLoopback);

    expect(report.dropped.some((line) => line.includes("40-image limit"))).toBe(
      true
    );
  });
});
