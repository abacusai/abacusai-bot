/** A chat preview asks main which folder a file shows under; outside them, the card adds the folder. */
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ transport: {} as any }));
vi.mock("../data/queries", async (original) => ({
  ...(await original<typeof import("../data/queries")>()),
  useSessionsTransport: () => mock.transport,
}));
const opened = vi.hoisted(() => ({ openHostPath: vi.fn(async () => {}) }));
vi.mock("#renderer/lib/open-host-path", () => opened);

import { SessionFilePreview } from "../files/files-tab";

const KEY = sessionConversationKey("w", "s");

/** Main's answers in order: each `previewRoot` call takes the next. */
const setup = (answers: object[]) => {
  const previewRoot = vi.fn(async (_input: object) => answers.shift());
  const add = vi.fn(async () => ({ folders: ["/Users/dev/Desktop"] }));
  const readText = vi.fn(async () => ({ content: "notes", truncated: false }));
  mock.transport = {
    client: {
      sessions: { folders: { add, remove: vi.fn() } },
      files: { readText },
      system: { openPath: vi.fn(), showItemInFolder: vi.fn() },
    },
    orpc: {
      browser: {
        runtime: {
          previewRoot: {
            key: () => ["previewRoot"],
            queryOptions: ({ input }: { input: object }) => ({
              queryKey: ["previewRoot", input],
              queryFn: () => previewRoot(input),
            }),
          },
        },
      },
    },
  };
  return { previewRoot, add, readText };
};

const renderPreview = (
  path: string,
  renderLocal: (path: string) => ReactNode = () => null
) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionFilePreview
        preview
        root="/s/session-home"
        path={path}
        scope={KEY}
        renderLocal={renderLocal}
      />
    </QueryClientProvider>
  );

it("a file outside the chat's folders gets the card; Add folder adds its folder and the preview opens", async () => {
  const { previewRoot, add } = setup([
    { ok: false, reason: "outside-folders", folder: "/Users/dev/Desktop" },
    { ok: true, root: "/Users/dev/Desktop" },
  ]);
  const renderLocal = vi.fn((_path: string) => <p>page</p>);
  const view = renderPreview("/Users/dev/Desktop/site.html", renderLocal);

  await view.findByText("sessions.folders.outsideTitle");
  expect(renderLocal).not.toHaveBeenCalled();
  expect(view.queryByRole("alert")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "sessions.folders.add" }));

  await view.findByText("page");
  expect(add).toHaveBeenCalledWith({
    sessionId: "s",
    path: "/Users/dev/Desktop",
  });
  expect(renderLocal).toHaveBeenCalledWith("/Users/dev/Desktop/site.html");
  expect(previewRoot).toHaveBeenCalledTimes(2);
  view.unmount();
});

it("Open with default app opens the file itself", async () => {
  setup([
    { ok: false, reason: "outside-folders", folder: "/Users/dev/Downloads" },
  ]);
  const view = renderPreview("/Users/dev/Downloads/report.pdf");
  fireEvent.click(
    await view.findByRole("button", {
      name: "bots.chat.preview.openExternally",
    })
  );
  await waitFor(() =>
    expect(opened.openHostPath).toHaveBeenCalledWith(
      mock.transport.client,
      "/Users/dev/Downloads/report.pdf"
    )
  );
  view.unmount();
});

it("text reads under the root main picked, not the file's own folder", async () => {
  const { readText } = setup([{ ok: true, root: "/Users/dev/Drive/site" }]);
  const view = renderPreview("/Users/dev/Drive/site/docs/notes.txt");
  await waitFor(() =>
    expect(readText).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "/Users/dev/Drive/site/docs/notes.txt",
        hostRoot: "/Users/dev/Drive/site",
      })
    )
  );
  view.unmount();
});
