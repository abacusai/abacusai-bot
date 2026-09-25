/**
 * The writer, checked against the reader this repo already has.
 *
 * A bundle nobody can open is worse than no bundle, and "it opened in my zip
 * tool" is not something a test can assert, so every case here writes an
 * archive and reads it back through services/pptx/zip.ts, which is a separate
 * implementation of the same spec.
 */
import { describe, expect, it } from "vitest";

import { ZipArchive } from "../pptx/zip";
import { buildZip } from "./zip-write";

const roundTrip = (name: string, content: Buffer): Buffer | null =>
  ZipArchive.open(buildZip([{ name, content }])).read(name);

describe("building a zip", () => {
  it("round-trips a file through the reader", () => {
    const content = Buffer.from("spawn npx ENOENT\n", "utf8");

    expect(roundTrip("logs/main-2026-08-21.log", content)?.toString()).toBe(
      content.toString()
    );
  });

  it("keeps every entry, in order", () => {
    const archive = ZipArchive.open(
      buildZip([
        { name: "summary.txt", content: Buffer.from("summary") },
        { name: "logs/main-2026-08-21.log", content: Buffer.from("main") },
        { name: "logs/agent-2026-08-21.log", content: Buffer.from("agent") },
      ])
    );

    expect(archive.list()).toEqual([
      "summary.txt",
      "logs/main-2026-08-21.log",
      "logs/agent-2026-08-21.log",
    ]);
  });

  it("survives an empty file, which a quiet day produces", () => {
    expect(
      roundTrip("logs/agent-2026-08-21.log", Buffer.alloc(0))?.length
    ).toBe(0);
  });

  it("handles a file large enough to actually compress", () => {
    const content = Buffer.from("[INFO] the same line, again\n".repeat(20_000));
    const archive = buildZip([{ name: "logs/main.log", content }]);

    expect(
      ZipArchive.open(archive).read("logs/main.log")?.equals(content)
    ).toBe(true);
    // Log text is repetitive; a bundle that did not compress would be a bundle
    // nobody wants to attach.
    expect(archive.length).toBeLessThan(content.length / 4);
  });

  it("keeps non-ASCII names and content intact", () => {
    const content = Buffer.from("réponse du modèle, 429\n", "utf8");

    expect(roundTrip("logs/journée.log", content)?.toString("utf8")).toBe(
      content.toString("utf8")
    );
  });

  it("records a real CRC and the sizes the directory promises", () => {
    const content = Buffer.from("checksum me");
    const archive = buildZip([{ name: "a.txt", content }]);

    // Straight out of the local header: a zero CRC or a wrong uncompressed
    // size is the classic way a hand-written zip opens everywhere except the
    // one tool the user has.
    expect(archive.readUInt32LE(14)).not.toBe(0);
    expect(archive.readUInt32LE(22)).toBe(content.length);
    expect(ZipArchive.open(archive).read("a.txt")?.equals(content)).toBe(true);
  });

  it("writes an archive with no files rather than throwing", () => {
    expect(() => ZipArchive.open(buildZip([]))).not.toThrow();
  });
});
