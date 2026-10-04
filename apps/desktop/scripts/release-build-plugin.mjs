import path from "node:path";
import { gzipSync } from "node:zlib";

import { buildProvenance } from "../../../scripts/build-provenance.mjs";
export const releaseBuildPlugin = (root, release, flags) => {
  let galleryMatches = 0;
  const web = root.replaceAll("\\", "/");
  const paths = /^[A-Za-z]:/.test(root) ? path.win32 : path;
  const desktop = paths.resolve(root, "../desktop").replaceAll("\\", "/");
  const normalizeId = (id) =>
    id
      .replaceAll("\\", "/")
      .replace(desktop, "<desktop>")
      .replace(web, "<web>");
  return {
    name: "abacus:release-build-provenance",
    enforce: "pre",
    applyToEnvironment: (environment) => environment.name === "client",
    load(id) {
      if (
        release &&
        id.split("?")[0].replaceAll("\\", "/") ===
          path.join(root, "src/routes/_bare/[__ui].tsx").replaceAll("\\", "/")
      ) {
        galleryMatches += 1;
        return 'import { createFileRoute, notFound } from "@tanstack/react-router"; export const Route = createFileRoute("/_bare/__ui")({ beforeLoad: () => { throw notFound(); } });';
      }
    },
    generateBundle(_options, bundle) {
      if (release && galleryMatches === 0)
        throw new Error("Gallery stub matched no modules");
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
                  id: normalizeId(id),
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
  };
};
