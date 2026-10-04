import { resolve } from "node:path";

import { createBuilder, normalizePath } from "vite";
import type { MultiEnvElectronOptions } from "vite-plugin-electron/multi-env";
import { describe, expect, it, vi } from "vitest";

const electronOptions = vi.hoisted(() => [] as MultiEnvElectronOptions[]);
vi.mock("vite-plugin-electron/multi-env", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("vite-plugin-electron/multi-env")>();
  return {
    ...actual,
    default: (options: MultiEnvElectronOptions[]) => {
      electronOptions.push(...options);
      return [];
    },
  };
});
const { default: config } = await import("../vite.config");
if (typeof config === "function")
  await config({
    command: "serve",
    mode: "development",
    isSsrBuild: false,
    isPreview: false,
  });

// Production builds (even --mode development) inherit the top-level aliases.
// Exercise the detached, configFile:false builder used by multi-env's dev path.
describe("detached Electron dev resolution", () => {
  for (const name of ["main", "preload"]) {
    it(`${name} resolves subpath files and directory indexes`, async () => {
      const options = electronOptions.find((option) => option.name === name)!;
      const root = resolve(import.meta.dirname, "..");
      const paths = {
        "@abacus-ai/contract/contract":
          "../../packages/contract/src/contract/index.ts",
        "@abacus-ai/contract/conversation-scope":
          "../../packages/contract/src/conversation-scope.ts",
        "#renderer/data/db": "../web/src/data/db/index.ts",
        "#renderer/features/sessions/device/device-tab":
          "../web/src/features/sessions/device/device-tab.tsx",
        "#renderer/components/bot-avatar":
          "../web/src/components/bot-avatar/index.tsx",
        "#main/rpc/procedures/impl": "src/main/rpc/procedures/impl.ts",
        "#preload/index": "src/preload/index.ts",
      };
      const loaded = new Set<string>();
      const builder = await createBuilder({
        configFile: false,
        root,
        publicDir: false,
        logLevel: "silent",
        environments: {
          [`electron_${name}`]: {
            ...options.options,
            consumer: "server",
            build: {
              write: false,
              rolldownOptions: {
                input: "\0alias-probe",
                platform: "node",
                plugins: [
                  options.plugins,
                  {
                    name: "alias-probe",
                    resolveId(id) {
                      if (id === "\0alias-probe") return id;
                    },
                    load(id) {
                      if (id === "\0alias-probe")
                        return Object.keys(paths)
                          .map((path) => `import ${JSON.stringify(path)};`)
                          .join("\n");
                      // Stop at the resolved targets so this test needs no
                      // native dependencies and never builds application code.
                      if (
                        Object.values(paths).some(
                          (path) => normalizePath(resolve(root, path)) === id
                        )
                      ) {
                        loaded.add(id);
                        return "console.log('alias resolved');";
                      }
                    },
                  },
                ],
              },
            },
          },
        },
      });
      await builder.build(builder.environments[`electron_${name}`]!);
      expect([...loaded].sort()).toEqual(
        Object.values(paths)
          .map((path) => normalizePath(resolve(root, path)))
          .sort()
      );
    });
  }
});
