/**
 * The file picker's native library has to be dlopen()ed from a real file.
 *
 * @ff-labs/fff-node computes the dylib path from its own location, so in a
 * packaged build that path runs through app.asar, which dlopen cannot read,
 * failing with ENOTDIR on the archive. The rewrite below is what keeps the
 * import pointed at the unpacked copy; these cases pin the shapes it has to
 * handle, including the Windows separator and the paths it must leave alone.
 */
import { describe, expect, it } from "vitest";

import { asarUnpackedPath, fffEntry } from "./file-search-service";

describe("asarUnpackedPath", () => {
  it("redirects a posix path inside the archive", () => {
    expect(
      asarUnpackedPath(
        "/Applications/AbacusAI-Bot.app/Contents/Resources/app.asar/node_modules/@ff-labs/fff-bin-darwin-arm64/libfff_c.dylib"
      )
    ).toBe(
      "/Applications/AbacusAI-Bot.app/Contents/Resources/app.asar.unpacked/node_modules/@ff-labs/fff-bin-darwin-arm64/libfff_c.dylib"
    );
  });

  it("redirects a windows path inside the archive", () => {
    expect(
      asarUnpackedPath(
        "C:\\Program Files\\AbacusAI-Bot\\resources\\app.asar\\node_modules\\@ff-labs\\fff-node\\dist\\src\\index.js"
      )
    ).toBe(
      "C:\\Program Files\\AbacusAI-Bot\\resources\\app.asar.unpacked\\node_modules\\@ff-labs\\fff-node\\dist\\src\\index.js"
    );
  });

  it("leaves a development path alone", () => {
    const dev =
      "/Users/dev/abacusai-bot/node_modules/@ff-labs/fff-node/dist/src/index.js";
    expect(asarUnpackedPath(dev)).toBe(dev);
  });

  it("does not rewrite an already-unpacked path", () => {
    const unpacked =
      "/Applications/AbacusAI-Bot.app/Contents/Resources/app.asar.unpacked/node_modules/@ff-labs/fff-node/dist/src/index.js";
    expect(asarUnpackedPath(unpacked)).toBe(unpacked);
  });

  it("resolves the import-only ESM package through its import condition", () => {
    const entry = fffEntry();
    expect(entry.startsWith("file:")).toBe(true);
    expect(entry.replaceAll("\\", "/")).toContain(
      "/@ff-labs/fff-node/dist/src/index.js"
    );
  });
});
