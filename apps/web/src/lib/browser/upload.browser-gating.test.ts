import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";

import { uploadFile } from "./upload";
vi.mock("#renderer/features/shell/connect/services", () => ({
  refreshUploadToken: async () => ({
    base: "https://host.test",
    token: "token",
  }),
}));
beforeEach(initI18n);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("retries temporary failures with backoff, preserves relative paths, and reports progress", async () => {
  vi.useFakeTimers();
  const requests: FakeRequest[] = [];
  class FakeRequest {
    upload: { onprogress?: (event: object) => void } = {};
    status = 503;
    responseText = "";
    onload?: () => void;
    onloadend?: () => void;
    open = vi.fn((_method: string, _url: string) => {});
    setRequestHeader = vi.fn();
    send(file: File) {
      requests.push(this);
      expect(file.name).toBe("Résumé.txt");
      if (requests.length === 2) {
        this.status = 200;
        this.responseText = JSON.stringify({
          success: true,
          paths: ["/vm/folder/Résumé.txt"],
        });
      }
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
      this.onload?.();
      this.onloadend?.();
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeRequest);
  const progress = vi.fn();
  const result = uploadFile(
    new File(["x"], "Résumé.txt"),
    { workspaceId: "w", sessionId: "s" },
    {
      batch: "batch",
      relativePath: "folder/Résumé.txt",
      signal: new AbortController().signal,
      progress,
    }
  );
  await vi.advanceTimersByTimeAsync(500);
  await expect(result).resolves.toBe("/vm/folder/Résumé.txt");
  expect(requests).toHaveLength(2);
  expect(
    new URL(requests[1]!.open.mock.calls[0]![1]).searchParams.get(
      "relativePath"
    )
  ).toBe("folder/Résumé.txt");
  expect(progress).toHaveBeenCalledWith(50);
});
it("cancels the active request without retrying", async () => {
  const abort = vi.fn();
  const send = vi.fn();
  class FakeRequest {
    upload = {};
    onabort?: () => void;
    onloadend?: () => void;
    open() {}
    setRequestHeader() {}
    send() {
      send();
    }
    abort() {
      abort();
      this.onabort?.();
      this.onloadend?.();
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeRequest);
  const controller = new AbortController();
  const result = uploadFile(
    new File(["x"], "a.txt"),
    { workspaceId: "w", sessionId: "s" },
    {
      batch: "batch",
      relativePath: "a.txt",
      signal: controller.signal,
      progress: () => {},
    }
  );
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  await Promise.resolve();
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(abort).toHaveBeenCalledOnce();
});
