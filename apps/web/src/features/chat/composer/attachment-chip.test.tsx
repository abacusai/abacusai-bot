import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { inertHostActions } from "../runtime/host-actions";
import { renderWithDb } from "../testing";
import { AttachmentChip } from "./attachment-chip";
import { addFiles, retryAttachment } from "./attachments";
import { draftStore, updateDraft } from "./draft-store";

let current: { cleanup(): Promise<void> } | undefined;
afterEach(async () => {
  await current?.cleanup();
  current = undefined;
  draftStore.setState(() => ({}));
});

it("shows a compact image chip with bounded hover preview and accessible remove", async () => {
  const remove = vi.fn();
  current = await renderWithDb(
    <AttachmentChip
      attachment={{
        id: "image",
        name: "layout.png",
        state: "done",
        path: null,
        preview: "data:image/png;base64,dummy",
        size: 2048,
      }}
      host={inertHostActions}
      root={null}
      onRemove={remove}
      onRetry={() => {}}
    />
  );
  expect(screen.getByText("2 KB")).toBeTruthy();
  expect(
    document
      .querySelector('[data-slot="attachment-chip"]')
      ?.getAttribute("data-size")
  ).toBe("chip");
  fireEvent.mouseEnter(screen.getByRole("button", { name: "layout.png" }));
  await screen.findByAltText("layout.png");
  fireEvent.click(screen.getByRole("button", { name: "Remove attachment" }));
  expect(remove).toHaveBeenCalledOnce();
});

it("announces upload errors and exposes retry without a tall error card", async () => {
  const retry = vi.fn();
  current = await renderWithDb(
    <AttachmentChip
      attachment={{
        id: "error",
        name: "notes.txt",
        state: "error",
        path: null,
        error: "Upload failed",
      }}
      host={inertHostActions}
      root={null}
      onRemove={() => {}}
      onRetry={retry}
    />
  );
  expect(screen.getByText("Upload failed")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry attachment" }));
  expect(retry).toHaveBeenCalledOnce();
  expect(
    document
      .querySelector('[data-slot="attachment-chip"]')
      ?.getAttribute("data-state")
  ).toBe("error");
});

it("finishes a retried upload only in its original composer after another draft is edited", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(Error("Offline"))
    .mockResolvedValueOnce(["/saved/notes.txt"]);
  const host = { ...inertHostActions, savePasted: save };
  await addFiles(
    "draft:first",
    [new File(["notes"], "notes.txt", { type: "text/plain" })],
    host,
    "/saved"
  );
  const attachment = draftStore.state["draft:first"]!.attachments[0]!;
  expect(attachment.state).toBe("error");
  updateDraft("draft:second", (d) => ({ ...d, text: "Other work" }));
  await act(async () => retryAttachment("draft:first", attachment.id, host));
  await waitFor(() =>
    expect(draftStore.state["draft:first"]?.attachments[0]?.state).toBe("done")
  );
  expect(draftStore.state["draft:second"]).toMatchObject({
    text: "Other work",
    attachments: [],
  });
});
