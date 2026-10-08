import { expect, it } from "vitest";

import { droppedFiles, isUploadJunk, relativeFilePath } from "./dropped-files";
it("reads every directory batch and preserves nested Unicode paths", async () => {
  const leaf = (name: string) => ({
    name,
    isFile: true,
    isDirectory: false,
    file: (done: (file: File) => void) => done(new File(["text"], name)),
  });
  const directory = (name: string, batches: unknown[][]) => ({
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => ({
      readEntries: (done: (entries: unknown[]) => void) =>
        done(batches.shift() ?? []),
    }),
  });
  const entry = directory("Résumé", [
    [leaf("first.txt")],
    [directory("nested", [[leaf("second.txt")]])],
    [],
  ]);
  const files = await droppedFiles({
    items: [{ webkitGetAsEntry: () => entry }],
    files: [],
  } as unknown as DataTransfer);
  expect(files.map(relativeFilePath)).toEqual([
    "Résumé/first.txt",
    "Résumé/nested/second.txt",
  ]);
});
it("falls back to browser files and filters junk at any depth", async () => {
  const file = new File(["image"], "photo.png", { type: "image/png" });
  expect(
    await droppedFiles({ items: [], files: [file] } as unknown as DataTransfer)
  ).toEqual([file]);
  Object.defineProperty(file, "webkitRelativePath", {
    value: "project/node_modules/photo.png",
  });
  expect(isUploadJunk(file)).toBe(true);
});
