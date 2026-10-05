import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import * as shim from "./electron-shim";
import { HostUnsupportedError } from "./unsupported";
it("exports every runtime Electron import, including dynamic imports", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const files = execFileSync(
    resolve(root, "packages/agent/vendor/rg"),
    ["--files", "apps/desktop/src", "-g", "*.ts"],
    { cwd: root, encoding: "utf8" }
  )
    .trim()
    .split("\n");
  const names = new Set<string>();
  for (const file of files) {
    const source = readFileSync(resolve(root, file), "utf8");
    for (const match of source.matchAll(
      /import\s*\{([^}]+)\}\s*from ["']electron["']|const\s*\{([^}]+)\}\s*=\s*await import\(["']electron["']\)/g
    )) {
      for (const part of (match[1] ?? match[2]).split(",")) {
        const name = part.trim();
        if (name && !name.startsWith("type ")) names.add(name.split(" as ")[0]);
      }
    }
  }
  expect(Object.keys(shim).sort()).toEqual([...names].sort());
});
it("throws on Electron UI use while preserving Node path and shell result contracts", async () => {
  expect(() => new shim.BrowserWindow()).toThrow(HostUnsupportedError);
  expect(() => shim.session.fromPartition("unsafe")).toThrow(
    HostUnsupportedError
  );
  expect(shim.app.getPath("userData")).toMatch(/host-userdata$/);
  expect(await shim.shell.openPath("/tmp/file")).not.toBe("");
});
