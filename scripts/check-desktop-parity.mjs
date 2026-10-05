import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
export const checkDesktopParity = (
  directory = resolve(import.meta.dirname, "../apps/desktop/dist/renderer")
) => {
  const baseline = JSON.parse(
    readFileSync(
      new URL("./fixtures/web-split-desktop-baseline.json", import.meta.url),
      "utf8"
    )
  );
  const actual = { chunks: 0, bytes: 0, gzipBytes: 0 };
  for (const file of readdirSync(directory, { recursive: true }).filter(
    (file) => file.endsWith(".js")
  )) {
    const bytes = readFileSync(resolve(directory, file));
    actual.chunks++;
    actual.bytes += bytes.length;
    actual.gzipBytes += gzipSync(bytes).length;
  }
  for (const key of Object.keys(actual))
    assert.ok(
      actual[key] <= baseline[key] * 1.01,
      `${key}: ${actual[key]} exceeds 99f20795 +1% (${baseline[key]}); see scripts/fixtures/web-split-desktop-baseline.md`
    );
  const graph = JSON.parse(
    readFileSync(resolve(directory, "chunk-sizes.json"), "utf8")
  );
  for (const chunk of graph) {
    const bytes = readFileSync(resolve(directory, chunk.file));
    assert.equal(chunk.bytes, bytes.length);
    assert.equal(
      chunk.gzipBytes,
      gzipSync(bytes).length,
      "Gzip accounting must use final emitted bytes"
    );
    assert.ok(
      chunk.modules.every(
        (module) => !module.id.startsWith("/") && !/^[A-Za-z]:/.test(module.id)
      ),
      "Absolute build paths in graph"
    );
  }
  return { baseline, actual };
};
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(checkDesktopParity(process.argv[2]));
