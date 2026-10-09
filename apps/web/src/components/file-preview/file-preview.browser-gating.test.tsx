import { ORPCError } from "@orpc/client";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";

import { FilePreview } from "./file-preview";

const files = vi.hoisted(() => ({
  size: vi.fn(),
  blob: vi.fn(),
  downloadUrl: vi.fn(),
}));
vi.mock("#renderer/lib/browser/host-files", () => ({ hostFiles: files }));
beforeAll(initI18n);
beforeEach(() => {
  files.size.mockResolvedValue(1024);
  files.downloadUrl.mockResolvedValue("https://host.test/files?ticket=scoped");
  files.blob.mockResolvedValue(new Blob(["preview"]));
  URL.createObjectURL = vi.fn(() => "blob:http://localhost/file");
  URL.revokeObjectURL = vi.fn();
});
const readers = () => ({
  text: vi.fn(async () => ({ content: "<h1>Todo</h1>", truncated: false })),
  image: vi.fn(async () => "data:image/png;base64,AAAA"),
});
it("reads HTML source, switches to a sandboxed preview, and revokes it on close", async () => {
  const read = readers();
  const view = render(
    <FilePreview path="/w/todo/index.html" hostRoot="/w" read={read} />
  );
  await waitFor(() =>
    expect(
      document.querySelector('[data-slot="file-preview-text"]')?.textContent
    ).toBe("<h1>Todo</h1>")
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview HTML" }));
  const frame = await screen.findByTitle("index.html");
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.getAttribute("src")).toBe("blob:http://localhost/file");
  expect(document.querySelector("webview")).toBeNull();
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(
    "blob:http://localhost/file"
  );
});
it("shows loading, a visible failure, and Retry replaces the failure with content", async () => {
  const read = readers();
  let reject!: (e: Error) => void;
  read.text.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      })
  );
  render(<FilePreview path="/w/a.txt" hostRoot="/w" read={read} />);
  expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
  reject(new Error("offline"));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("<h1>Todo</h1>");
});
it("renders binary size and offers an authenticated download", async () => {
  render(<FilePreview path="/w/a.bin" hostRoot="/w" read={readers()} />);
  await screen.findByText(/Binary file.*1,024 bytes/);
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(click).toHaveBeenCalled());
  expect(files.downloadUrl).toHaveBeenCalledWith({
    filePath: "/w/a.bin",
    hostRoot: "/w",
  });
});
it("handles binary content detected in a text file", async () => {
  const read = readers();
  read.text.mockRejectedValueOnce(
    new ORPCError("CONFLICT", { data: { reason: "binary-file" } })
  );
  render(<FilePreview path="/w/a.txt" hostRoot="/w" read={read} />);
  await screen.findByText(/Binary file/);
});
it("shows truncated text, images, PDF and empty text without a native viewer", async () => {
  const read = readers();
  read.text.mockResolvedValueOnce({ content: "", truncated: true });
  const view = render(
    <FilePreview path="/w/large.txt" hostRoot="/w" read={read} />
  );
  await screen.findByRole("note");
  view.rerender(<FilePreview path="/w/image.png" hostRoot="/w" read={read} />);
  await screen.findByRole("img", { name: "image.png" });
  view.rerender(<FilePreview path="/w/report.pdf" hostRoot="/w" read={read} />);
  await screen.findByTitle("report.pdf");
  expect(document.querySelector("iframe")?.hasAttribute("sandbox")).toBe(false);
});
it("ignores an old read after selection changes and avoids refetching for inline reader objects", async () => {
  const read = readers();
  let resolve!: (value: { content: string; truncated: boolean }) => void;
  read.text.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const view = render(
    <FilePreview path="/w/old.txt" hostRoot="/w" read={{ ...read }} />
  );
  view.rerender(
    <FilePreview path="/w/new.txt" hostRoot="/w" read={{ ...read }} />
  );
  await screen.findByText("<h1>Todo</h1>");
  resolve({ content: "stale content", truncated: false });
  await Promise.resolve();
  expect(screen.queryByText("stale content")).toBeNull();
  view.rerender(
    <FilePreview path="/w/new.txt" hostRoot="/w" read={{ ...read }} />
  );
  expect(read.text).toHaveBeenCalledTimes(2);
});
it("changes from source to a rendered preview for the same file when opening a preview tab", async () => {
  const read = readers();
  const view = render(
    <FilePreview path="/w/index.html" hostRoot="/w" read={read} />
  );
  await waitFor(() =>
    expect(
      document.querySelector('[data-slot="file-preview-text"]')?.textContent
    ).toBe("<h1>Todo</h1>")
  );
  view.rerender(
    <FilePreview
      path="/w/index.html"
      hostRoot="/w"
      read={read}
      initialView="preview"
    />
  );
  expect((await screen.findByTitle("index.html")).tagName).toBe("IFRAME");
  view.rerender(<FilePreview path="/w/other.html" hostRoot="/w" read={read} />);
  await waitFor(() =>
    expect(
      document.querySelector('[data-slot="file-preview-text"]')?.textContent
    ).toBe("<h1>Todo</h1>")
  );
  expect(screen.queryByTitle("other.html")).toBeNull();
});
