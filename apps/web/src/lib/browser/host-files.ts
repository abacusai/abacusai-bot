import { ORPCError } from "@orpc/client";

import type { AppClient } from "#renderer/data/transport/types";

export type HostFile = { filePath: string; hostRoot: string };
type Download = HostFile | { whisperUrl: string };

const response = async (
  input: Download,
  signal?: AbortSignal,
  maxBytes?: number,
  probe = false,
  method: "GET" | "POST" = "GET"
): Promise<Response> => {
  const { refreshUploadToken } =
    await import("#renderer/features/shell/connect/services");
  let host = await refreshUploadToken();
  const query = new URLSearchParams(
    "whisperUrl" in input
      ? input
      : {
          path: input.filePath,
          hostRoot: input.hostRoot,
        }
  );
  if (maxBytes != null) query.set("maxBytes", String(maxBytes));
  const token = host.token;
  const fetchFile = () =>
    fetch(`${host.base}/files?${query}`, {
      credentials: "include",
      method,
      headers: {
        Authorization: `Bearer ${host.token}`,
        ...(probe ? { Range: "bytes=0-0" } : {}),
      },
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(30_000),
      ]),
    });
  let result = await fetchFile();
  const failure =
    result.status === 403
      ? ((await result
          .clone()
          .json()
          .catch(() => null)) as { error?: string; reason?: string } | null)
      : null;
  const authFailure =
    result.status === 401 ||
    (result.status === 403 &&
      (!failure || (failure.error === "forbidden" && !failure.reason)));
  if (authFailure) {
    await result.body?.cancel();
    host = await refreshUploadToken(true, token);
    result = await fetchFile();
  }
  return result;
};
const fileError = (input: Download, reason: string) =>
  reason === "not-found"
    ? new ORPCError("NOT_FOUND", {
        defined: true,
        data: {
          entity: "file",
          id: "filePath" in input ? input.filePath : input.whisperUrl,
        },
      })
    : new ORPCError(
        reason === "outside-root" || reason === "forbidden"
          ? "FORBIDDEN"
          : "CONFLICT",
        {
          defined: true,
          data: { reason },
        }
      );
const checked = async (
  input: Download,
  signal?: AbortSignal,
  maxBytes?: number,
  probe = false,
  method: "GET" | "POST" = "GET"
): Promise<Response> => {
  const result = await response(input, signal, maxBytes, probe, method);
  if (
    !result.ok &&
    !(
      probe &&
      result.status === 416 &&
      result.headers.get("content-range") === "bytes */0"
    )
  ) {
    const body = (await result.json().catch(() => null)) as {
      error?: string;
      reason?: string;
    } | null;
    throw fileError(
      input,
      body?.reason ??
        body?.error ??
        (result.status === 404
          ? "not-found"
          : result.status === 403
            ? "forbidden"
            : "download-failed")
    );
  }
  return result;
};
const sizeOf = (result: Response): number | undefined => {
  const rangeSize = result.headers.get("content-range")?.match(/\/(\d+)$/)?.[1];
  const value =
    rangeSize ??
    result.headers.get("x-file-size") ??
    result.headers.get("content-length");
  return value != null && Number.isFinite(Number(value))
    ? Number(value)
    : undefined;
};
/** Never retain more than the limit, even when Content-Length is absent. */
const boundedBytes = async (
  result: Response,
  limit: number,
  input: Download,
  rejectOverflow = false
) => {
  if (rejectOverflow && (sizeOf(result) ?? 0) > limit) {
    await result.body?.cancel();
    throw fileError(input, "too-large");
  }
  const reader = result.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.length > limit) {
        if (rejectOverflow) throw fileError(input, "too-large");
        truncated = true;
      }
      const chunk = value.subarray(0, limit - size);
      chunks.push(chunk);
      size += chunk.length;
      if (truncated) break;
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
};
const imageMime: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
};
export const hostFiles = {
  response,
  downloadUrl: async (input: HostFile) => {
    const result = await checked(input, undefined, undefined, false, "POST");
    const value = (await result.json()) as { ticket?: unknown };
    if (typeof value.ticket !== "string")
      throw fileError(input, "download-failed");
    const { refreshUploadToken } =
      await import("#renderer/features/shell/connect/services");
    const host = await refreshUploadToken();
    return `${host.base}/files?${new URLSearchParams({ path: input.filePath, hostRoot: input.hostRoot, ticket: value.ticket })}`;
  },
  size: async (input: HostFile, signal?: AbortSignal) => {
    const result = await checked(input, signal, undefined, true);
    await result.body?.cancel();
    return sizeOf(result) ?? 0;
  },
  blob: async (input: Download, signal?: AbortSignal) =>
    (await checked(input, signal)).blob(),
  arrayBuffer: async (input: Download, signal?: AbortSignal) =>
    (await checked(input, signal)).arrayBuffer(),
  text: async (input: Download, signal?: AbortSignal) =>
    (await checked(input, signal)).text(),
};

export const readHostImage: AppClient["files"]["readImageAsDataUrl"] = async (
  input,
  options
) => {
  const mimeType =
    imageMime[input.filePath.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!mimeType) throw fileError(input, "unsupported-extension");
  const result = await checked(input, options?.signal);
  const { bytes } = await boundedBytes(result, 8 * 1024 * 1024, input, true);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes], { type: mimeType }));
  });
  return { dataUrl, mimeType, sizeBytes: bytes.byteLength };
};
export const readHostText: AppClient["files"]["readText"] = async (
  input,
  options
) => {
  const limit = input.maxBytes ?? 524288;
  const probe = limit === 1;
  const result = await checked(
    input,
    options?.signal,
    probe ? undefined : limit + 1,
    probe
  );
  const { bytes, truncated } = await boundedBytes(result, limit, input);
  const encoding =
    bytes[0] === 255 && bytes[1] === 254
      ? "utf-16le"
      : bytes[0] === 254 && bytes[1] === 255
        ? "utf-16be"
        : "utf-8";
  if (encoding === "utf-8" && bytes.subarray(0, 8192).includes(0))
    throw fileError(input, "binary-file");
  const sizeBytes = sizeOf(result) ?? bytes.length + Number(truncated);
  return {
    content: new TextDecoder(encoding).decode(bytes),
    sizeBytes,
    truncated: truncated || (probe && sizeBytes > limit),
  };
};

export const readHostPptx: AppClient["files"]["readPptx"] = async (
  input,
  options
) => {
  const result = await checked(input, options?.signal);
  const { bytes } = await boundedBytes(result, 60 * 1024 * 1024, input, true);
  const [{ default: JSZip }, { parsePptx }] = await Promise.all([
    import("jszip"),
    import("@abacus-ai/contract/pptx/parser"),
  ]);
  const zip = await JSZip.loadAsync(bytes);
  const entries = new Map<string, Uint8Array>();
  for (const entry of Object.values(zip.files)) {
    if (
      !entry.dir &&
      (/\.(xml|rels)$/i.test(entry.name) ||
        /\.(png|jpe?g|gif|webp|bmp|ico|svg|tiff?)$/i.test(entry.name))
    )
      entries.set(entry.name, await entry.async("uint8array"));
  }
  const deck = parsePptx({
    list: () => [...entries.keys()],
    read: (name) => entries.get(name) ?? null,
    readText: (name) => {
      const value = entries.get(name);
      return value ? new TextDecoder().decode(value) : null;
    },
  });
  return { deck, sizeBytes: bytes.byteLength };
};

/** All browser readers share this boundary, including query utilities. */
export const browserFileCall = async (
  path: readonly string[],
  input: unknown,
  next: () => Promise<unknown>,
  signal?: AbortSignal
): Promise<unknown> => {
  const procedure = path.join(".");
  const readers = {
    "files.readImageAsDataUrl": readHostImage,
    "files.readText": readHostText,
    "files.readPptx": readHostPptx,
  };
  const reader = readers[procedure as keyof typeof readers];
  if (reader) return reader(input as HostFile, { signal });
  return next();
};
