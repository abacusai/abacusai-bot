import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkReleaseBuild } from "./check-release-build.mjs";
import { releaseBuildPlugin } from "./release-build-plugin.mjs";

test("release boot graph follows static imports but permits deferred presentation", () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "release-graph-"));
  try {
    fs.mkdirSync(path.join(dist, "renderer"));
    fs.mkdirSync(path.join(dist, "main"));
    const write = (name, value) =>
      fs.writeFileSync(path.join(dist, "renderer", name), value);
    write(
      "release-build.json",
      JSON.stringify({ gallery: false, fixtures: false, modules: [] })
    );
    write("index.html", '<script src="/assets/main.js"></script>');
    const graph = [
      {
        file: "assets/main.js",
        imports: ["assets/shared.js"],
        modules: [],
        dynamicImports: ["assets/chat.js"],
      },
      { file: "assets/shared.js", imports: [], modules: [] },
      {
        file: "assets/chat.js",
        imports: [],
        modules: [
          { id: "<desktop>/src/renderer/features/chat/markdown/markdown.tsx" },
        ],
      },
    ];
    write("chunk-sizes.json", JSON.stringify(graph));
    assert.doesNotThrow(() => checkReleaseBuild(dist));
    graph[1].modules = graph[2].modules;
    write("chunk-sizes.json", JSON.stringify(graph));
    assert.throws(() => checkReleaseBuild(dist), /Deferred presentation code/);
    graph[1].modules = Array.from({ length: 101 }, (_, i) => ({
      id: `/node_modules/lucide-react/dist/esm/icons/icon-${i}.mjs`,
    }));
    write("chunk-sizes.json", JSON.stringify(graph));
    assert.throws(() => checkReleaseBuild(dist), /Heavy icon catalog/);
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test("release gallery exclusion accepts Windows and normalized module ids", () => {
  const root = "D:\\a\\abacusai-bot\\apps\\desktop";
  const route = path.win32.join(root, "src/renderer/routes/_bare/[__ui].tsx");
  const plugin = releaseBuildPlugin(root, true, {});
  for (const id of [
    route,
    route.replaceAll("\\", "/"),
    `${route}?split=component`,
  ]) {
    assert.match(plugin.load(id), /throw notFound\(\)/);
  }
  assert.equal(
    plugin.load(path.win32.join(root, "src/renderer/routes/__root.tsx")),
    undefined
  );
  assert.equal(releaseBuildPlugin(root, false, {}).load(route), undefined);
});
