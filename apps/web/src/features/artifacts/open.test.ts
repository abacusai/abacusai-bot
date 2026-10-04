import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import type { Transport } from "#renderer/data/transport";
import type { ArtifactRow } from "#shared/contract/rows";

import { openArtifact } from "./data";
const artifact = { kind: "file", location: "/work/report.md" } as ArtifactRow;
const fixture = (failure?: unknown) => {
  const readText = vi.fn(async () => {
    if (failure) throw failure;
    return {};
  });
  const openPath = vi.fn(async () => ({ outcome: "opened" }));
  const reveal = vi.fn(async () => {});
  const transport = {
    client: {
      files: { readText },
      system: { openPath, showItemInFolder: reveal },
    },
  } as unknown as Transport;
  return { transport, readText, openPath, reveal };
};
describe("R5-T15 typed artifact probe", () => {
  it("missing files never launch a path", async () => {
    const f = fixture(
      new ORPCError("NOT_FOUND", {
        defined: true,
        data: { reason: "not-found" },
        message: "anything",
      })
    );
    expect(await openArtifact(f.transport, artifact)).toBe("missing");
    expect(f.openPath).not.toHaveBeenCalled();
  });
  it("directories reveal without launching", async () => {
    const f = fixture(
      new ORPCError("CONFLICT", {
        defined: true,
        data: { reason: "not-a-file" },
        message: "anything",
      })
    );
    expect(await openArtifact(f.transport, artifact)).toBe("directory");
    expect(f.reveal).toHaveBeenCalledWith({ path: artifact.location });
    expect(f.openPath).not.toHaveBeenCalled();
  });
  it.each(["FORBIDDEN", "CONFLICT"] as const)(
    "%s delegates the final decision to openPath",
    async (code) => {
      const f = fixture(
        new ORPCError(code, {
          defined: true,
          data: { reason: "outside-root" },
          message: "file missing",
        })
      );
      expect(await openArtifact(f.transport, artifact)).toBe("opened");
      expect(f.openPath).toHaveBeenCalledOnce();
    }
  );
  it("unexpected failures remain errors", async () => {
    const failure = new Error("not-a-file");
    const f = fixture(failure);
    await expect(openArtifact(f.transport, artifact)).rejects.toBe(failure);
    expect(f.openPath).not.toHaveBeenCalled();
  });
});
