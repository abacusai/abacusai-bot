import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-notices-"));
  roots.push(root);
  const write = (file: string, text: string) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  const json = (file: string, value: object) =>
    write(file, JSON.stringify(value));
  json("package.json", { type: "module" });
  json("apps/desktop/package.json", {
    name: "desktop",
    dependencies: { runtime: "1" },
    devDependencies: { unused: "1" },
  });
  json("apps/updater/package.json", {
    name: "updater",
    dependencies: { updates: "1" },
  });
  json("packages/agent/package.json", { name: "agent" });
  json("packages/agent/dist/main.js.map", {
    sources: ["../../../node_modules/bundled/index.js"],
  });
  json("apps/desktop/build/licenses/sources.json", []);
  write("apps/desktop/resources/decks/TEMPLATES-LICENSE", "Template copyright");
  write("apps/desktop/resources/pdf/fonts/LICENSE-font.txt", "Font copyright");
  for (const name of [
    "runtime",
    "updates",
    "bundled",
    "transitive",
    "unused",
  ]) {
    json(`node_modules/${name}/package.json`, {
      name,
      version: "1.0.0",
      license: "MIT",
      ...(name === "bundled"
        ? {
            dependencies: { transitive: "1" },
            optionalDependencies: { absent: "1" },
          }
        : {}),
    });
    write(
      `node_modules/${name}/LICENSE`,
      `Copyright ${name}\nOriginal upstream license`
    );
  }
  write("node_modules/runtime/NOTICE", "Runtime attribution must be retained");
  const spdxRoot = path.dirname(require.resolve("spdx-license-list/full.js"));
  for (const file of ["full.js", "spdx-full.json"]) {
    write(
      `node_modules/spdx-license-list/${file}`,
      fs.readFileSync(path.join(spdxRoot, file), "utf8")
    );
  }
  write(
    "apps/desktop/scripts/generate-notices.js",
    fs.readFileSync(
      path.resolve(import.meta.dirname, "../../scripts/generate-notices.js"),
      "utf8"
    )
  );
  const run = () => {
    execFileSync(
      process.execPath,
      [path.join(root, "apps/desktop/scripts/generate-notices.js")],
      { stdio: "pipe" }
    );
    return fs.readFileSync(
      path.join(root, "apps/desktop/dist/THIRD-PARTY-NOTICES.txt"),
      "utf8"
    );
  };
  return { root, json, run };
}

it("includes runtime, bundled, transitive and asset licenses without unrelated dev tools", () => {
  const { run } = fixture();
  const result = run();
  for (const name of ["runtime", "updates", "bundled", "transitive"])
    expect(result).toContain(`${name}@1.0.0`);
  expect(result).not.toContain("unused@1.0.0");
  expect(result).toContain("Runtime attribution must be retained");
  expect(result).toContain("Template copyright");
  expect(result).toContain("Font copyright");
  expect(run()).toBe(result);
});

it("includes declared standard terms and attribution when the npm tarball omits its license", () => {
  const { root, json, run } = fixture();
  fs.unlinkSync(path.join(root, "node_modules/runtime/LICENSE"));
  json("node_modules/runtime/package.json", {
    name: "runtime",
    version: "1.0.0",
    license: "MIT",
    author: "Original Author",
  });
  const result = run();
  expect(result).toContain("Original Author");
  expect(result).toContain("Permission is hereby granted");
  expect(result).toContain("no separate license file");
  expect(result).toContain("Runtime attribution must be retained");
});

it("does not silently omit a dependency whose license cannot be resolved", () => {
  const { root, json, run } = fixture();
  fs.unlinkSync(path.join(root, "node_modules/runtime/LICENSE"));
  json("node_modules/runtime/package.json", {
    name: "runtime",
    version: "1.0.0",
  });
  expect(run).toThrow("Upstream license text missing for: runtime@1.0.0");
});
