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
test("browser boundary rejects the real Vite client resolver and direct requests", async () => {
  const { createJiti } = await import("jiti");
  const { browserBoundaryPlugin, rendererAlias, platformAlias, webRoot } =
    await createJiti(import.meta.url).import("../apps/web/vite.renderer.ts");
  const { createServer } =
    await import("../node_modules/vite/dist/node/index.js");
  const server = await createServer({
    configFile: false,
    root: webRoot,
    logLevel: "silent",
    plugins: [browserBoundaryPlugin()],
    resolve: { alias: { ...rendererAlias, ...platformAlias("browser") } },
    server: { middlewareMode: true },
  });
  try {
    const container = server.environments.client.pluginContainer;
    const importer = `${webRoot}/src/features/shell/index.tsx`;
    for (const id of [
      "#renderer/features/shell/native-presenter",
      "./native-presenter.ts",
      "#renderer/platform/transport.electron",
      "#renderer/data/transport/message-port",
      "#renderer/features/sessions/browser/browser-tab",
      "#renderer/components/browser-surface",
      "#renderer/components/browser-surface/index.tsx",
    ])
      await assert.rejects(
        container.resolveId(id, importer),
        /Electron-only module/,
        id
      );
    for (const id of [
      "/src/features/shell/native-presenter.ts",
      "/src/platform/transport.electron.ts",
      "/src/data/transport/message-port.ts",
    ])
      await assert.rejects(server.transformRequest(id), /Electron-only module/);
    const allowed = await container.resolveId("#platform/transport", importer);
    assert.match(allowed.id, /transport\.browser\.ts$/);
  } finally {
    await server.close();
  }
});
test("browser boundary rejects static and dynamic imports in actual builds", async () => {
  const { createJiti } = await import("jiti");
  const { browserBoundaryPlugin, rendererAlias, platformAlias, webRoot } =
    await createJiti(import.meta.url).import("../apps/web/vite.renderer.ts");
  const { build } = await import("../node_modules/vite/dist/node/index.js");
  for (const target of [
    "#renderer/features/shell/native-presenter",
    "#renderer/platform/transport.electron",
    "#renderer/data/transport/message-port",
  ]) {
    for (const dynamic of [false, true]) {
      await assert.rejects(
        build({
          configFile: false,
          root: webRoot,
          logLevel: "silent",
          resolve: { alias: { ...rendererAlias, ...platformAlias("browser") } },
          plugins: [
            browserBoundaryPlugin(),
            {
              name: "boundary-canary-entry",
              resolveId(id) {
                if (id === "virtual:boundary-canary")
                  return "\0boundary-canary";
              },
              load(id) {
                if (id === "\0boundary-canary")
                  return dynamic
                    ? `import(${JSON.stringify(target)}).then(console.log)`
                    : `import * as native from ${JSON.stringify(target)}; console.log(native)`;
              },
            },
          ],
          build: {
            write: false,
            rolldownOptions: { input: "virtual:boundary-canary" },
          },
        }),
        /Electron-only module/
      );
    }
  }
});
test("browser boundary checks loaded, transformed and final graph ids independently", async () => {
  const { createJiti } = await import("jiti");
  const { browserBoundaryPlugin } = await createJiti(import.meta.url).import(
    "../apps/web/vite.renderer.ts"
  );
  const plugin = browserBoundaryPlugin();
  const id = "/repo/apps/web/src/platform/transport.electron.ts?direct";
  assert.throws(() => plugin.load(id), /Electron-only module/);
  assert.throws(() => plugin.transform("", id), /Electron-only module/);
  assert.throws(
    () => plugin.generateBundle.call({ getModuleIds: () => [id] }),
    /Electron-only module/
  );
});
