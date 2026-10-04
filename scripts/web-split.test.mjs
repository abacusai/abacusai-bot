import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
const web = "apps/web";
test("web configuration canaries still point at the renderer tree", () => {
  const components = JSON.parse(readFileSync(`${web}/components.json`));
  assert.equal(components.tailwind.css, "src/styles/app.css");
  assert.ok(existsSync(`${web}/${components.tailwind.css}`));
  const imports = JSON.parse(readFileSync(`${web}/package.json`)).imports;
  assert.ok(imports["#renderer/*"].includes("./src/*/index.tsx"));
  assert.ok(existsSync(`${web}/src/components/bot-avatar/index.tsx`));
  assert.ok(existsSync(`${web}/src/routes/_bare/[__ui].tsx`));
  assert.ok(existsSync("packages/contract/src/contract/index.ts"));
});
test("browser boundary checks resolved targets for alias, relative, extension and index imports", async () => {
  const { createJiti } = await import("jiti");
  const { browserBoundaryPlugin } = await createJiti(import.meta.url).import(
    "../apps/web/vite.renderer.ts"
  );
  const plugin = browserBoundaryPlugin();
  for (const specifier of [
    "#renderer/features/shell/native-presenter",
    "./native-presenter",
    "../shell/native-presenter.ts",
    "../browser/index.tsx",
  ]) {
    const target = specifier.includes("browser")
      ? "features/sessions/browser/index.tsx"
      : "features/shell/native-presenter.ts";
    await assert.rejects(
      plugin.resolveId.call(
        { resolve: async () => ({ id: `/repo/apps/web/src/${target}` }) },
        specifier,
        "/repo/apps/web/src/shared.ts"
      ),
      /Electron-only module/
    );
  }
  assert.deepEqual(
    await plugin.resolveId.call(
      {
        resolve: async () => ({
          id: "/repo/apps/web/src/platform/presenter.browser.ts",
        }),
      },
      "#platform/presenter"
    ),
    { id: "/repo/apps/web/src/platform/presenter.browser.ts" }
  );
});
