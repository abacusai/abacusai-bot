import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/bootstrap.ts",
    "src/classify.ts",
    "src/dev.ts",
    "src/experience.ts",
    "src/manifest.ts",
    "src/publish.ts",
    "src/refresh.ts",
    "src/repository.ts",
    "src/server.ts",
  ],
  dts: true,
  format: "esm",
  platform: "node",
  target: "node22",
});
