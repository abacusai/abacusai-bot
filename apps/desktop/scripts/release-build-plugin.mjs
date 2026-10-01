import path from "node:path";
import { gzipSync } from "node:zlib";

import { buildProvenance } from "../../../scripts/build-provenance.mjs";
export const releaseBuildPlugin = (root, release, flags) => ({
  name: "abacus:release-build-provenance",
  enforce: "pre",
  applyToEnvironment: (environment) => environment.name === "client",
  load(id) {
    if (
      release &&
      id.split("?")[0] ===
        path.join(root, "src/renderer/routes/_bare/[__ui].tsx")
    )
      return 'import { createFileRoute, notFound } from "@tanstack/react-router"; export const Route = createFileRoute("/_bare/__ui")({ beforeLoad: () => { throw notFound(); } });';
  },
  generateBundle(_options, bundle) {
    const modules = [
      ...new Set(
        Object.values(bundle).flatMap((chunk) =>
          chunk.type === "chunk"
            ? Object.entries(chunk.modules)
                .filter(([, info]) => info.renderedLength !== 0)
                .map(([id]) => id.replaceAll("\\", "/"))
            : []
        )
      ),
    ].sort();
    this.emitFile({
      type: "asset",
      fileName: "chunk-sizes.json",
      source: JSON.stringify(
        Object.values(bundle)
          .filter((c) => c.type === "chunk")
          .map((c) => ({
            file: c.fileName,
            gzipBytes: gzipSync(c.code).length,
            imports: c.imports,
            dynamicImports: c.dynamicImports,
            modules: Object.entries(c.modules)
              .filter(([, info]) => info.renderedLength > 0)
              .map(([id, info]) => ({
                id: id.replaceAll("\\", "/").replace(root, "<desktop>"),
                renderedBytes: info.renderedLength,
              }))
              .sort((a, b) => b.renderedBytes - a.renderedBytes),
          }))
      ),
    });
    this.emitFile({
      type: "asset",
      fileName: "build.json",
      source: JSON.stringify(buildProvenance()) + "\n",
    });
    this.emitFile({
      type: "asset",
      fileName: "release-build.json",
      source:
        JSON.stringify({
          gallery: !!flags.gallery,
          fixtures: !!flags.fixtures,
          modules,
        }) + "\n",
    });
  },
});
