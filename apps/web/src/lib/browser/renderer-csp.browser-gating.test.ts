import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, it } from "vitest";

it("pins the Electron injected policy to its main-process copy and permits only self/data fonts on both platforms", async () => {
  // Build configuration lives outside the renderer TypeScript project.
  const configPath = resolve(import.meta.dirname, "../../../vite.renderer.ts");
  const { rendererCsp } = (await import(configPath)) as {
    rendererCsp(
      platform: "electron" | "browser",
      env: Record<string, string>
    ): string;
  };
  // Read native source outside the browser graph boundary.
  const source = readFileSync(
    resolve(
      import.meta.dirname,
      "../../../../desktop/src/main/renderer-csp.ts"
    ),
    "utf8"
  );
  const strings = source
    .slice(
      source.indexOf("export const RENDERER_CSP ="),
      source.indexOf("interface HeadersReceivedDetails")
    )
    .match(/"[^"\n]*"/g)!;
  const pinned = strings.map((value) => JSON.parse(value) as string).join("");
  expect(rendererCsp("electron", {})).toBe(pinned);
  for (const platform of ["electron", "browser"] as const) {
    expect(
      rendererCsp(platform, {})
        .split(";")
        .map((rule) => rule.trim())
    ).toContain("font-src 'self' data:");
  }
  const html = readFileSync(
    resolve(import.meta.dirname, "../../../index.html"),
    "utf8"
  );
  expect(html).toContain('href="%BASE_URL%favicon.png"');
  expect(
    readFileSync(resolve(import.meta.dirname, "../../../public/favicon.png"))
  ).toEqual(
    readFileSync(
      resolve(import.meta.dirname, "../../../../desktop/build/icons/32x32.png")
    )
  );
});
