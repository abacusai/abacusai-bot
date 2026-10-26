import { createRequire } from "node:module";

import { expect, it } from "vitest";

// patches/app-builder-lib@26.18.0.patch sets the Windows installer's archive.
// If an electron-builder bump leaves the patch behind, the installer quietly
// returns to a 1 MB dictionary, non-solid archive, 12% larger.
const fromBuilder = createRequire(
  createRequire(import.meta.url).resolve("electron-builder/package.json")
);
const lib = createRequire(fromBuilder.resolve("app-builder-lib/package.json"));
const { configureDifferentialAwareArchiveOptions } = lib(
  "./out/targets/differentialUpdateInfoBuilder.js"
);
const { compute7zCompressArgs } = lib("./out/targets/archive.js");

it("packs the differential-aware installer with a 64 MB dictionary, solid per extension", () => {
  const options = configureDifferentialAwareArchiveOptions({
    compression: "maximum",
  });
  expect(options).toMatchObject({ dictSize: 64, solid: "e" });
  const args = compute7zCompressArgs("7z", options);
  expect(args).toContain("-md=64m");
  expect(args).toContain("-ms=e");
  expect(args).not.toContain("-ms=off");
});
