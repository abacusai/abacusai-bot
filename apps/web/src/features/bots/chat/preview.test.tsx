import { contract } from "@abacus-ai/contract/contract";
import type { FilesEvent } from "@abacus-ai/contract/contract/files";
/**
 * R3-T33 (routing half): URLs go to the browser tab, viewable files to the
 * preview with the right containment root, the rest to the OS app;
 * `preview-open` for another conversation or a non-viewable type opens
 * nothing (review r1 #10/#11).
 */
import { implement } from "@orpc/server";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createMemoryTransport } from "#renderer/data/transport/memory";

import {
  openBotFile,
  usePreviewOpenBridge,
  type BotOpenTarget,
} from "./preview";

describe("openBotFile", () => {
  it("routes URLs to the browser tab", () => {
    expect(openBotFile("https://x.dev", "/w")).toEqual({
      kind: "browser",
      url: "https://x.dev",
    });
  });
  it("routes viewable files to the preview with the right root", () => {
    expect(openBotFile("notes/a.md", "/w")).toEqual({
      kind: "preview",
      path: "/w/notes/a.md",
      hostRoot: "/w/notes",
    });
    expect(openBotFile("/workspace/a.md", "/host")).toEqual({
      kind: "preview",
      path: "/workspace/a.md",
      hostRoot: "/host",
    });
  });
  it("hands binaries and office documents to the OS", () => {
    expect(openBotFile("report.docx", "/w")).toEqual({
      kind: "external",
      path: "/w/report.docx",
    });
  });
});

describe("preview-open bridge", () => {
  const events: FilesEvent[] = [];
  const impl = implement(contract);
  const router = {
    files: {
      events: impl.files.events.handler(async function* () {
        for (const event of events) yield event;
        await new Promise(() => {});
      }),
    },
  };

  const Bridge = ({ open }: { open(target: BotOpenTarget): void }) => {
    usePreviewOpenBridge(transport, "mine", "/w", open);
    return null;
  };
  let transport: ReturnType<typeof createMemoryTransport>;

  it("opens only this conversation's viewable items", async () => {
    events.push(
      {
        type: "preview-open",
        path: "/w/a.md",
        conversationKey: "other" as never,
      },
      {
        type: "preview-open",
        path: "/w/b.docx",
        conversationKey: "mine" as never,
      },
      {
        type: "preview-open",
        path: "https://x.dev",
        conversationKey: "mine" as never,
      },
      {
        type: "preview-open",
        path: "/w/c.md",
        conversationKey: "mine" as never,
      }
    );
    transport = createMemoryTransport(router as never, {});
    const open = vi.fn();
    const { unmount } = render(<Bridge open={open} />);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(open.mock.calls.map(([target]) => target)).toEqual([
      { kind: "browser", url: "https://x.dev" },
      { kind: "preview", path: "/w/c.md", hostRoot: "/w" },
    ]);
    unmount();
    transport.close();
  });
});
