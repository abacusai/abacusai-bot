import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { FOUNDATION_API, PROTOCOL, buildManifest } from "./manifest.ts";
const stamp = {
  commit: "a".repeat(40),
  dirty: false,
  foundationApi: FOUNDATION_API,
  protocol: PROTOCOL,
  generation: FOUNDATION_API >= 2 ? "wco" : "legacy",
  builtAt: "2026-10-01T00:00:00.000Z",
};
it.each(["missing", "commit", "foundationApi", "protocol", "generation"])(
  "R7-T2: builder refuses %s provenance",
  async (field) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "provenance-"));
    try {
      for (const role of ["renderer", "agent"]) {
        await fs.mkdir(path.join(root, role));
        await fs.writeFile(
          path.join(root, role, "build.json"),
          JSON.stringify(stamp)
        );
      }
      const file = path.join(root, "agent", "build.json");
      if (field === "missing") await fs.rm(file);
      else
        await fs.writeFile(
          file,
          JSON.stringify({
            ...stamp,
            [field]:
              field === "commit"
                ? "b".repeat(40)
                : field === "foundationApi"
                  ? FOUNDATION_API + 1
                  : field === "generation"
                    ? "other"
                    : "other/1",
          })
        );
      await expect(buildManifest(root, "1.2.3")).rejects.toThrow(/provenance/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);
