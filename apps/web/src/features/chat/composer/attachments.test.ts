import { beforeEach, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";

import { inertHostActions } from "../runtime/host-actions";
import {
  addFiles,
  addPaths,
  removeAttachment,
  retryAttachment,
} from "./attachments";
import { draftStore } from "./draft-store";
const context = async () => ({ workspaceId: "w", sessionId: "s" });
beforeEach(async () => {
  await initI18n();
  draftStore.setState(() => ({}));
});
it("streams nested files into one computer folder descriptor without reading bytes", async () => {
  const first = new File(["one"], "one.txt");
  Object.defineProperty(first, "webkitRelativePath", {
    value: "folder/nested/one.txt",
  });
  const second = new File(["two"], "two.txt");
  Object.defineProperty(second, "webkitRelativePath", {
    value: "folder/two.txt",
  });
  const bytes = vi.spyOn(first, "arrayBuffer");
  const uploadFile = vi.fn(async (_file, _context, options) => {
    options.progress(50);
    return `/vm/.abacusai-bot/temp/${options.batch}/${options.relativePath}`;
  });
  await addFiles(
    "thread",
    [first, second],
    { ...inertHostActions, uploadFile },
    "/vm",
    context
  );
  const attachment = draftStore.state.thread!.attachments[0]!;
  expect(attachment).toMatchObject({
    name: "folder",
    state: "done",
    source: "computer",
    size: 6,
    progress: 100,
  });
  expect(attachment.path).toMatch(/\/folder$/);
  expect(attachment.files?.map((file) => file.name)).toEqual([
    "folder/nested/one.txt",
    "folder/two.txt",
  ]);
  expect(bytes).not.toHaveBeenCalled();
  expect(uploadFile).toHaveBeenCalledTimes(2);
});
it("retains failures for retry and aborts a removed upload", async () => {
  let succeed = false;
  const uploadFile = vi.fn(async (_file, _context, options) => {
    if (!succeed) throw new Error("offline");
    return `/vm/${options.relativePath}`;
  });
  await addFiles(
    "thread",
    [new File(["text"], "a.txt")],
    { ...inertHostActions, uploadFile },
    "/vm",
    context
  );
  const attachment = draftStore.state.thread!.attachments[0]!;
  expect(attachment).toMatchObject({ state: "error", error: "offline" });
  succeed = true;
  retryAttachment(attachment.id);
  await vi.waitFor(() =>
    expect(draftStore.state.thread!.attachments[0]!.state).toBe("done")
  );
  let signal: AbortSignal | undefined;
  const pending = addFiles(
    "thread",
    [new File(["text"], "b.txt")],
    {
      ...inertHostActions,
      uploadFile: async (_file, _context, options) => {
        signal = options.signal;
        return new Promise((_resolve, reject) =>
          options.signal.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError"))
          )
        );
      },
    },
    "/vm",
    context
  );
  await vi.waitFor(() => expect(signal).toBeDefined());
  removeAttachment("thread", draftStore.state.thread!.attachments[1]!.id);
  await pending;
  expect(signal!.aborted).toBe(true);
  expect(draftStore.state.thread!.attachments).toHaveLength(1);
});
it("rejects oversize files visibly before transport", async () => {
  const file = new File([], "huge.bin");
  Object.defineProperty(file, "size", { value: 257 * 1024 * 1024 });
  const uploadFile = vi.fn();
  // Avoid a large-folder confirmation in this limit-specific case.
  const dialog = await import("#renderer/lib/browser/host-dialog");
  vi.spyOn(dialog, "confirmUpload").mockResolvedValue(false);
  await addFiles(
    "thread",
    [file],
    { ...inertHostActions, uploadFile },
    "/vm",
    context
  );
  expect(draftStore.state.thread!.attachments[0]!.state).toBe("error");
  expect(uploadFile).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
it("VM and native paths use the same completed descriptor and native paste keeps its RPC", async () => {
  addPaths("thread", [{ path: "/vm/existing.txt", source: "vm" }]);
  const savePasted = vi.fn(async () => ["/native/image.png"]);
  await addFiles(
    "thread",
    [new File(["image"], "paste.png", { type: "image/png" })],
    { ...inertHostActions, savePasted },
    "/native"
  );
  expect(savePasted).toHaveBeenCalledTimes(1);
  expect(
    draftStore.state.thread!.attachments.map(({ path, state }) => ({
      path,
      state,
    }))
  ).toEqual([
    { path: "/vm/existing.txt", state: "done" },
    { path: "/native/image.png", state: "done" },
  ]);
});
