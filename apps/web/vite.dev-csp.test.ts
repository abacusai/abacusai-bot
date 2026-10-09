import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { expect, it } from "vitest";

import { platformPlugin, rendererCsp, webRoot } from "./vite.renderer";

it.each(["electron", "browser"] as const)(
  "authorizes the real %s refresh preamble with a dev-only nonce",
  async (platform) => {
    const server = await createServer({
      configFile: false,
      root: webRoot,
      plugins: [
        ...(await platformPlugin(platform, "development", "serve")),
        react(),
      ],
      server: { middlewareMode: true, watch: null },
    });
    try {
      const html = await server.transformIndexHtml(
        "/index.html",
        "<!doctype html><html><head></head><body></body></html>"
      );
      const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/
        .exec(html)?.[1]
        ?.replaceAll("&#39;", "'");
      const nonce = server.config.html.cspNonce;
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{24}$/);
      expect(
        policy?.split(";").find((value) => value.includes("script-src"))
      ).toBe(` script-src 'self' 'unsafe-eval' 'nonce-${nonce}'`);
      expect(html).toContain("injectIntoGlobalHook");
      const inline = [
        ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi),
      ].filter((match) => !/\bsrc=/.test(match[1]!) && match[2]!.trim());
      expect(inline.length).toBeGreaterThan(0);
      for (const script of inline)
        expect(script[1]).toContain(`nonce="${nonce}"`);
    } finally {
      await server.close();
    }

    const buildPlugins = await platformPlugin(platform, "development", "build");
    const hook = buildPlugins[0]!.transformIndexHtml;
    if (typeof hook !== "function")
      throw new Error("Missing platform HTML hook");
    const result = await hook.call({} as never, "<html></html>", {} as never);
    expect(result).toMatchObject({
      tags: [{ attrs: { content: rendererCsp(platform) } }],
    });
    expect(JSON.stringify(result)).not.toContain("nonce-");
  }
);
