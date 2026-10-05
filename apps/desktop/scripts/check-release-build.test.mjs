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
    write("notch.html", "<div></div>");
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
        modules: [{ id: "<web>/src/features/chat/markdown/markdown.tsx" }],
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
  const root = "D:\\a\\abacusai-bot\\apps\\web";
  const route = path.win32.join(root, "src/routes/_bare/[__ui].tsx");
  const plugin = releaseBuildPlugin(root, true, {});
  for (const id of [
    route,
    route.replaceAll("\\", "/"),
    `${route}?split=component`,
  ]) {
    assert.match(plugin.load(id), /throw notFound\(\)/);
  }
  assert.equal(
    plugin.load(path.win32.join(root, "src/routes/__root.tsx")),
    undefined
  );
  assert.equal(releaseBuildPlugin(root, false, {}).load(route), undefined);
});

test("release guard refuses a zero-match gallery and normalizes both roots", () => {
  const root = "D:\\a\\repo\\apps\\web";
  const plugin = releaseBuildPlugin(root, true, {});
  const assets = [];
  const context = { emitFile: (asset) => assets.push(asset) };
  assert.throws(
    () => plugin.generateBundle.call(context, {}, {}),
    /matched no modules/
  );
  plugin.load(path.win32.join(root, "src/routes/_bare/[__ui].tsx"));
  plugin.generateBundle.call(
    context,
    {},
    {
      chunk: {
        type: "chunk",
        fileName: "assets/main.js",
        code: "",
        imports: [],
        dynamicImports: [],
        modules: {
          "D:\\a\\repo\\apps\\web\\src\\main.tsx": { renderedLength: 1 },
          "D:\\a\\repo\\apps\\desktop\\src\\main\\index.ts": {
            renderedLength: 1,
          },
        },
      },
    }
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chunk-graph-"));
  fs.mkdirSync(path.join(directory, "assets"));
  fs.writeFileSync(path.join(directory, "assets/main.js"), "final bytes");
  plugin.writeBundle({ dir: directory });
  const graph = JSON.parse(
    fs.readFileSync(path.join(directory, "chunk-sizes.json"), "utf8")
  );
  assert.equal(graph[0].bytes, Buffer.byteLength("final bytes"));
  fs.rmSync(directory, { recursive: true });
  assert.deepEqual(graph[0].modules.map((module) => module.id).sort(), [
    "<desktop>/src/main/index.ts",
    "<web>/src/main.tsx",
  ]);
});
