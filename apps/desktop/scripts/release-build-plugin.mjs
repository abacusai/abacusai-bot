import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { buildProvenance } from "../../../scripts/build-provenance.mjs";
export const releaseBuildPlugin = (
  root,
  release,
  flags,
  platform = "electron"
) => {
  let galleryMatches = 0;
  const web = root.replaceAll("\\", "/");
  const paths = /^[A-Za-z]:/.test(root) ? path.win32 : path;
  const desktop = paths.resolve(root, "../desktop").replaceAll("\\", "/");
  let sizes;
  const repository = paths.resolve(root, "../..").replaceAll("\\", "/");
  const contract = paths
    .resolve(root, "../../packages/contract")
    .replaceAll("\\", "/");
  const normalizeId = (id) =>
    id
      .replaceAll("\\", "/")
      .replace(desktop, "<desktop>")
      .replace(web, "<web>")
      .replace(contract, "<contract>")
      .replace(repository, "<root>");
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
                  .map(([id]) => normalizeId(id))
              : []
          )
        ),
      ].sort();
      sizes = Object.values(bundle)
        .filter((c) => c.type === "chunk")
        .map((c) => ({
          file: c.fileName,
          imports: c.imports,
          dynamicImports: c.dynamicImports,
          modules: Object.entries(c.modules)
            .filter(([, info]) => info.renderedLength > 0)
            .map(([id, info]) => ({
              id: normalizeId(id),
              renderedBytes: info.renderedLength,
            }))
            .sort((a, b) => b.renderedBytes - a.renderedBytes),
        }));
      this.emitFile({
        type: "asset",
        fileName: "build.json",
        source: JSON.stringify(buildProvenance()) + "\n",
      });
      if (platform === "electron")
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
    writeBundle(options) {
      const directory = options.dir;
      const final = sizes.map((chunk) => {
        const bytes = readFileSync(path.join(directory, chunk.file));
        return {
          ...chunk,
          bytes: bytes.length,
          gzipBytes: gzipSync(bytes).length,
        };
      });
      const destination =
        platform === "browser"
          ? path.resolve(directory, "../build-metadata/chunk-sizes.json")
          : path.join(directory, "chunk-sizes.json");
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, JSON.stringify(final));
    },
  };
};
