import { builtinModules } from "node:module";

import { CONNECTORS, connectUi } from "@abacus-ai/connectors/registry";
import { build } from "vite";
import { expect, it } from "vitest";

it("R5-T33 bundles the catalogue into a browser entry with no Node built-ins", async () => {
  const builtins = new Set(builtinModules.flatMap((id) => [id, `node:${id}`]));
  const result = await build({
    configFile: false,
    logLevel: "silent",
    plugins: [
      {
        name: "registry-browser-probe",
        resolveId(id) {
          if (builtins.has(id))
            throw new Error(`Node built-in in renderer catalogue: ${id}`);
          if (id === "registry-browser-probe")
            return "\0registry-browser-probe";
        },
        load(id) {
          if (id === "\0registry-browser-probe")
            return 'import { CONNECTORS, connectUi } from "@abacus-ai/connectors/registry"; console.log(CONNECTORS);';
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: "registry-browser-probe" },
    },
  });
  expect(result).toBeDefined();
  expect(CONNECTORS.length).toBeGreaterThan(20);
  for (const connector of CONNECTORS)
    expect(["browser-hop", "fields", "pairing", "none"]).toContain(
      connectUi(connector)
    );
});
