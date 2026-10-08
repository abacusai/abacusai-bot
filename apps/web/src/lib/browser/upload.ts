import { UPLOAD_LIMITS } from "@abacus-ai/contract/contract/files";

import { i18n } from "#renderer/lib/i18n";

import type { UploadContext } from "./files";
export interface UploadOptions {
  signal: AbortSignal;
  progress: (percent: number) => void;
  batch: string;
  relativePath: string;
}
class TransientUploadError extends Error {}

export const uploadFile = async (
  file: File,
  context: UploadContext,
  options: UploadOptions
): Promise<string> => {
  if (file.size > UPLOAD_LIMITS.fileBytes)
    throw new Error(i18n.t("web.files.tooLarge"));
  const { refreshUploadToken } =
    await import("#renderer/features/shell/connect/services");
  let host = await refreshUploadToken();
  const send = (): Promise<string> =>
    new Promise((resolve, reject) => {
      if (options.signal.aborted) {
        reject(new DOMException("Cancelled", "AbortError"));
        return;
      }
      const request = new XMLHttpRequest();
      request.open(
        "POST",
        `${host.base}/upload?${new URLSearchParams({ ...context, batch: options.batch, relativePath: options.relativePath })}`
      );
      request.withCredentials = true;
      request.timeout = 120_000;
      request.setRequestHeader("Authorization", `Bearer ${host.token}`);
      request.setRequestHeader(
        "Content-Type",
        file.type || "application/octet-stream"
      );
      const abort = () => request.abort();
      options.signal.addEventListener("abort", abort, { once: true });
      request.onloadend = () =>
        options.signal.removeEventListener("abort", abort);
      request.upload.onprogress = (event) => {
        if (event.lengthComputable)
          options.progress(Math.floor((event.loaded / event.total) * 100));
      };
      request.onabort = () =>
        reject(new DOMException("Cancelled", "AbortError"));
      request.onerror = request.ontimeout = () =>
        reject(new TransientUploadError(i18n.t("web.files.uploadFailed")));
      request.onload = () => {
        if (request.status === 401 || request.status === 403) {
          reject(new Error("upload-auth"));
          return;
        }
        try {
          if (request.status >= 500)
            throw new TransientUploadError(i18n.t("web.files.uploadFailed"));
          const value = JSON.parse(request.responseText) as {
            success?: boolean;
            paths?: string[];
          };
          if (
            request.status !== 200 ||
            !value.success ||
            typeof value.paths?.[0] !== "string"
          )
            throw new Error(
              i18n.t(
                request.status === 413
                  ? "web.files.tooLarge"
                  : "web.files.uploadFailed"
              )
            );
          resolve(value.paths[0]);
        } catch (error) {
          reject(
            error instanceof SyntaxError
              ? new Error(i18n.t("web.files.uploadFailed"))
              : error
          );
        }
      };
      request.send(file);
    });
  let refreshed = false;
  for (let retry = 0; ; retry++) {
    try {
      return await send();
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "upload-auth" &&
        !refreshed
      ) {
        host = await refreshUploadToken(true, host.token);
        refreshed = true;
        continue;
      }
      if (
        !(error instanceof TransientUploadError) ||
        retry >= 2 ||
        options.signal.aborted
      )
        throw error;
      await new Promise<void>((resolve, reject) => {
        const cancelled = () => {
          clearTimeout(timer);
          reject(new DOMException("Cancelled", "AbortError"));
        };
        const timer = setTimeout(
          () => {
            options.signal.removeEventListener("abort", cancelled);
            resolve();
          },
          500 * 2 ** retry
        );
        options.signal.addEventListener("abort", cancelled, { once: true });
      });
    }
  }
};
