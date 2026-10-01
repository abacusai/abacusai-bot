import path from "node:path";

import { buildProvenance } from "../../../scripts/build-provenance.mjs";
export const releaseBuildPlugin = (root, release, flags) => ({
  name: "abacus:release-build-provenance",
  enforce: "pre",
  applyToEnvironment: (environment) => environment.name === "client",
  load(id) {
    if (
      release &&
      id.split("?")[0] ===
        path.join(root, "src/renderer-next/routes/_bare/[__ui].tsx")
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
