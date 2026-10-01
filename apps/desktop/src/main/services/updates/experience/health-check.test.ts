import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { checkAgentBundle } from "./health-check";
for (const wire of ["agui"] as const) {
  it(`R7-T8: health check uses ${wire} readiness and exact arguments in an isolated home`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "health-fixture-"));
    try {
      await fs.mkdir(path.join(root, "agent"));
      const args =
        wire === "agui"
          ? ["--thread-id", "health-check"]
          : ["--wire", "ndjson"];
      const ready =
        wire === "agui"
          ? { type: "CUSTOM", name: "session.ready" }
          : { type: "ready" };
      await fs.writeFile(
        path.join(root, "agent", "main.js"),
        `if(JSON.stringify(process.argv.slice(2))!==${JSON.stringify(JSON.stringify(args))})process.exit(64); console.log(${JSON.stringify(JSON.stringify(ready))});setInterval(()=>{},1000);`
      );
      await expect(checkAgentBundle(root)).resolves.toBeUndefined();
      await fs.writeFile(
        path.join(root, "agent", "main.js"),
        'console.log(JSON.stringify({type:"RUN_ERROR"}));setInterval(()=>{},1000);'
      );
      await expect(checkAgentBundle(root)).rejects.toThrow("RUN_ERROR");
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });
}

it.each([
  ["exits without readiness", "process.exit(77)"],
  [
    "only speaks NDJSON ready",
    'console.log(JSON.stringify({type:"ready"}));setTimeout(()=>process.exit(0),20)',
  ],
])("R7-T8 AG-UI refuses a candidate that %s", async (_name, source) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "health-refusal-"));
  try {
    await fs.mkdir(path.join(root, "agent"));
    await fs.writeFile(path.join(root, "agent", "main.js"), source);
    await expect(checkAgentBundle(root)).rejects.toThrow();
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});
