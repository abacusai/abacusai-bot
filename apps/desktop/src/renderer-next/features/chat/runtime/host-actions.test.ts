import { describe, expect, it, vi } from "vitest";

import { createMemoryTransport } from "#next/data/transport/memory";

import { hostActionsFor } from "./host-actions";

describe("path-only attachments", () => {
  it("reads native metadata and the preload path without reading bytes or calling RPC", async () => {
    const file = new File(["large contents"], "clip.mp4");
    const bytes = vi.spyOn(file, "arrayBuffer");
    const path = vi.fn(() => "/workspace/clip.mp4");
    const transport = createMemoryTransport(
      {},
      {},
      { host: { getPathForFile: path } }
    );
    const pick = hostActionsFor(transport).pickFiles();
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    await expect(pick).resolves.toEqual([
      { path: "/workspace/clip.mp4", name: "clip.mp4", size: file.size },
    ]);
    expect(bytes).not.toHaveBeenCalled();
    expect(path).toHaveBeenCalledWith(file);
    expect(input.isConnected).toBe(false);
    await transport.close();
  });
  it("cancellation removes the picker", async () => {
    const transport = createMemoryTransport({}, {});
    const pick = hostActionsFor(transport).pickFiles();
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    input.dispatchEvent(new Event("cancel"));
    await expect(pick).resolves.toBeNull();
    expect(input.isConnected).toBe(false);
    await transport.close();
  });
});
