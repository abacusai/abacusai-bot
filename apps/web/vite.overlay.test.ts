import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, test } from "vitest";

import {
  WEB_OVERLAY_ENV,
  cspHash,
  inlineHashes,
  loadWebOverlay,
  mergeCsp,
  overlayCsp,
  overlayTags,
  validateWebOverlay,
} from "./vite.overlay.ts";
import {
  platformPlugin,
  rendererCsp,
  webRoot,
  type WebOverlay,
} from "./vite.renderer.ts";

const BASE = rendererCsp("browser", {});
const temp = mkdtempSync(join(tmpdir(), "web-overlay-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const context = { mode: "production", command: "build" as const, env: {} };
const module = (name: string, source: string) => {
  const path = join(temp, name);
  writeFileSync(path, source);
  return path;
};
const load = (name: string, source: string) =>
  loadWebOverlay(context, { [WEB_OVERLAY_ENV]: module(name, source) });

describe("mergeCsp", () => {
  test("appends to an existing directive without duplicating it", () => {
    const csp = mergeCsp(BASE, {
      "connect-src": ["https://api.example", "'self'"],
    });
    expect(csp).toContain("connect-src 'self' https://api.example;");
    expect(csp.match(/connect-src/g)).toHaveLength(1);
    expect(csp).not.toContain("\n");
  });
  test("creates a missing directive, seeded from its fallback", () => {
    const csp = mergeCsp(BASE, { "worker-src": ["blob:"] });
    expect(csp).toMatch(/; worker-src 'self' 'unsafe-eval' blob:;$/);
    expect(mergeCsp(BASE, { "object-src": ["https://o.example"] })).toMatch(
      /; object-src 'self' https:\/\/o.example;$/
    );
    expect(mergeCsp(BASE, { "base-uri": ["'self'"] })).toMatch(
      /; base-uri 'self';$/
    );
  });
  test("keeps 'none' unless the overlay lists sources for the directive", () => {
    const none = "default-src 'self'; object-src 'none'; frame-src 'none';";
    expect(mergeCsp(none, { "object-src": [] })).toBe(none);
    expect(mergeCsp(none, { "connect-src": ["https://a.example"] })).toBe(
      "default-src 'self'; object-src 'none'; frame-src 'none'; connect-src 'self' https://a.example;"
    );
    expect(mergeCsp(none, { "frame-src": ["https://f.example"] })).toBe(
      "default-src 'self'; object-src 'none'; frame-src https://f.example;"
    );
  });
  test("deduplicates sources and keeps the policy on one line", () => {
    const csp = mergeCsp("script-src 'self'", {
      "script-src": ["https://s.example", "https://s.example", "'self'"],
    });
    expect(csp).toBe("script-src 'self' https://s.example;");
  });
  test("an empty addition leaves the policy as it was", () => {
    expect(mergeCsp(BASE, {})).toBe(BASE);
    expect(mergeCsp(BASE, { "img-src": [] })).toBe(BASE);
  });
});

describe("inline hashes", () => {
  // SHA-256("abc") = ba7816bf…, a published test vector.
  const ABC = "'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='";
  test("cspHash matches the known vector", () => {
    expect(cspHash("abc")).toBe(ABC);
    expect(cspHash("")).toBe(
      "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='"
    );
  });
  test("inline script children land in script-src", () => {
    const overlay: WebOverlay = {
      head: [{ tag: "script", children: "abc" }],
      body: [
        { tag: "script", attrs: { src: "https://s.example/x.js" } },
        { tag: "div", children: "abc" },
      ],
    };
    expect(inlineHashes(BASE, overlay)).toEqual({ "script-src": [ABC] });
    const csp = overlayCsp(BASE, overlay);
    expect(csp).toContain(`script-src 'self' 'unsafe-eval' ${ABC};`);
    // External script origins are the overlay's to declare.
    expect(csp).not.toContain("s.example");
  });
  test("style children are hashed only where 'unsafe-inline' is absent", () => {
    const overlay: WebOverlay = { head: [{ tag: "style", children: "abc" }] };
    // The base policy allows inline styles; a hash would switch that off.
    expect(inlineHashes(BASE, overlay)).toEqual({});
    expect(overlayCsp(BASE, overlay)).toBe(BASE);
    expect(inlineHashes("style-src 'self';", overlay)).toEqual({
      "style-src": [ABC],
    });
  });
  test("a script directive that allows inline gets no hash", () => {
    const overlay: WebOverlay = {
      csp: { "script-src": ["'unsafe-inline'"] },
      head: [{ tag: "script", children: "abc" }],
    };
    expect(overlayCsp(BASE, overlay)).toContain(
      "script-src 'self' 'unsafe-eval' 'unsafe-inline';"
    );
  });
});

describe("overlayTags", () => {
  test("defaults injectTo by section and keeps an explicit one", () => {
    expect(
      overlayTags({
        head: [{ tag: "meta" }, { tag: "link", injectTo: "head-prepend" }],
        body: [{ tag: "script" }],
      })
    ).toEqual([
      { tag: "meta", injectTo: "head" },
      { tag: "link", injectTo: "head-prepend" },
      { tag: "script", injectTo: "body" },
    ]);
  });
});

describe("validateWebOverlay", () => {
  test.each([
    [null, /overlay must be an object/],
    [{ extra: 1 }, /unknown field "extra"/],
    [{ csp: [] }, /"csp" must be an object/],
    [{ csp: { "child-src": [] } }, /"csp.child-src" is not a supported/],
    [{ csp: { "img-src": "x" } }, /"csp.img-src" must be an array/],
    [{ csp: { "img-src": ["a b"] } }, /"csp.img-src" must be an array/],
    [{ csp: { "img-src": ["a;"] } }, /"csp.img-src" must be an array/],
    [{ head: {} }, /"head" must be an array/],
    [{ body: [{ attrs: {} }] }, /"body\[0\]" must be a tag descriptor/],
    [{ head: [{ tag: "script", children: 1 }] }, /"head\[0\].children"/],
    [{ transformHtml: "x" }, /"transformHtml" must be a function/],
    [{ define: 1 }, /"define" must be an object/],
    [{ define: { A: 1 } }, /"define.A" must be a JSON-encoded string/],
  ])("rejects %j", (value, message) => {
    expect(() => validateWebOverlay(value)).toThrow(message);
    expect(() => validateWebOverlay(value)).toThrow(WEB_OVERLAY_ENV);
  });
  test("accepts a complete overlay", () => {
    const overlay: WebOverlay = {
      csp: { "connect-src": ["https://a.example"] },
      head: [{ tag: "script", children: "1" }],
      body: [{ tag: "noscript", children: [{ tag: "img" }] }],
      transformHtml: (html) => html,
      define: { __X__: JSON.stringify("x") },
    };
    expect(validateWebOverlay(overlay)).toBe(overlay);
  });
});

describe("loadWebOverlay", () => {
  test("is undefined without the env", async () => {
    expect(await loadWebOverlay(context, {})).toBeUndefined();
    expect(await loadWebOverlay(context, { [WEB_OVERLAY_ENV]: "" })).toBe(
      undefined
    );
  });
  test("requires an absolute path", async () => {
    await expect(
      loadWebOverlay(context, { [WEB_OVERLAY_ENV]: "overlay.mjs" })
    ).rejects.toThrow(/must be an absolute path/);
  });
  test("loads an object export", async () => {
    await expect(
      load("object.mjs", 'export default { csp: { "img-src": ["data:"] } };')
    ).resolves.toEqual({ csp: { "img-src": ["data:"] } });
  });
  test("calls a function export with the context", async () => {
    const overlay = await loadWebOverlay(
      { mode: "staging", command: "serve", env: { X: "1" } },
      {
        [WEB_OVERLAY_ENV]: module(
          "function.mjs",
          "export default async (ctx) => ({ define: { __CTX__: JSON.stringify(ctx) } });"
        ),
      }
    );
    expect(JSON.parse(overlay?.define?.__CTX__ ?? "")).toEqual({
      mode: "staging",
      command: "serve",
      env: { X: "1" },
    });
  });
  test("names a missing default export and an invalid field", async () => {
    await expect(load("named.mjs", "export const a = 1;")).rejects.toThrow(
      /has no default export/
    );
    await expect(
      load("bad.mjs", 'export default { csp: { "img-src": "x" } };')
    ).rejects.toThrow(/"csp.img-src"/);
  });
});

describe("platformPlugin", () => {
  const overlayPath = module(
    "plugin.mjs",
    `export default {
      csp: { "connect-src": ["https://api.example"] },
      head: [{ tag: "script", children: "abc" }],
      transformHtml: (html) => html + "<!-- after -->",
    };`
  );
  const withEnv = async <T>(fn: () => Promise<T>) => {
    const previous = process.env[WEB_OVERLAY_ENV];
    process.env[WEB_OVERLAY_ENV] = overlayPath;
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env[WEB_OVERLAY_ENV];
      else process.env[WEB_OVERLAY_ENV] = previous;
    }
  };
  const cspOf = (plugins: Awaited<ReturnType<typeof platformPlugin>>) => {
    const hook = plugins[0]?.transformIndexHtml;
    if (typeof hook !== "function") throw new Error("no html hook");
    const result = (
      hook as (html: string) => {
        tags: { attrs: { content: string } }[];
      }
    )("<html></html>");
    return result.tags[0]?.attrs.content;
  };
  test("Electron ignores the env", async () => {
    const plugins = await withEnv(() => platformPlugin("electron"));
    expect(plugins).toHaveLength(1);
    expect(cspOf(plugins)).toBe(rendererCsp("electron"));
  });
  test("the browser build and dev server apply it", async () => {
    for (const command of ["build", "serve"]) {
      const plugins = await withEnv(() =>
        platformPlugin("browser", "production", command)
      );
      expect(plugins.map((p) => p.name)).toEqual([
        "abacus:platform",
        "abacus:web-overlay-html",
      ]);
      expect(cspOf(plugins)).toContain("https://api.example");
      expect(cspOf(plugins)).toContain(cspHash("abc"));
    }
  });
});

describe("vite build", () => {
  const MARKER = "<!-- overlay:transformed -->";
  const INLINE = "window.__example = 'EXAMPLE_ID';";
  const fixture = module(
    "fixture.mjs",
    `export default ({ command }) => ({
      csp: {
        "script-src": ["https://scripts.example"],
        "connect-src": ["https://api.example"],
      },
      head: [
        { tag: "script", children: ${JSON.stringify(INLINE)} },
        { tag: "script", attrs: { async: true, src: "https://scripts.example/tag.js" } },
      ],
      transformHtml: (html) => html.replace("</body>", ${JSON.stringify(MARKER)} + "\\n</body>"),
      define: { __OVERLAY_COMMAND__: JSON.stringify(command) },
    });`
  );
  const build = (name: string, env: Record<string, string>) => {
    const outDir = join(temp, name);
    execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("bin/vite.js", import.meta.resolve("vite/package.json"))
        ),
        "build",
        "--outDir",
        outDir,
        "--logLevel",
        "error",
      ],
      {
        cwd: webRoot,
        stdio: "pipe",
        env: { ...process.env, [WEB_OVERLAY_ENV]: "", ...env },
      }
    );
    return readFileSync(join(outDir, "index.html"), "utf8").replaceAll(
      "&#39;",
      "'"
    );
  };
  const cspOf = (html: string) =>
    /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];
  test("the fixture overlay reaches the built index.html", () => {
    const html = build("with-overlay", { [WEB_OVERLAY_ENV]: fixture });
    expect(html).toContain(`<script>${INLINE}</script>`);
    expect(html).toContain(
      '<script async src="https://scripts.example/tag.js"></script>'
    );
    expect(html).toContain(MARKER);
    const csp = cspOf(html) ?? "";
    expect(csp).toContain(
      `script-src 'self' 'unsafe-eval' https://scripts.example ${cspHash(INLINE)};`
    );
    expect(csp).toContain("connect-src 'self' https://api.example;");
    expect(csp.match(/script-src/g)).toHaveLength(1);
    // The CSP still precedes every script (scripts/check-web-bundle.mjs).
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(
      html.indexOf("<script")
    );
  });
  test("without the env the output is today's", () => {
    const html = build("without-overlay", {});
    expect(cspOf(html)).toBe(rendererCsp("browser", process.env));
    expect(html).not.toContain("example");
    expect(html).not.toContain(MARKER);
    expect(html).not.toContain("sha256-");
  });
});
