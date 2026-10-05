import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import { rendererCsp } from "../../web/vite.renderer";
import { RENDERER_CSP } from "../src/main/renderer-csp";
it("R8-T7 pins Electron CSP and refuses a missing platform", () => {
  expect(rendererCsp("electron", {})).toBe(RENDERER_CSP);
  expect(() => rendererCsp(undefined as never, {})).toThrow("platform");
  expect(() => rendererCsp("browser", { VITE_CONNECT_SRC: "" })).toThrow(
    "VITE_CONNECT_SRC"
  );
  expect(rendererCsp("browser", {})).toContain(
    "connect-src 'self' https://*.preview.apps.abacus.ai wss://*.preview.apps.abacus.ai;"
  );
});
it("the web root HTML loads its source entry and carries no CSP", () => {
  const html = readFileSync(
    resolve(import.meta.dirname, "../../web/index.html"),
    "utf8"
  );
  expect(html).toContain('src="/src/main.tsx"');
  expect(html).not.toContain("Content-Security-Policy");
});
