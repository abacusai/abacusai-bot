import type { AppClient } from "#renderer/data/transport/types";

export type HostFile = { filePath: string; hostRoot: string };
type Download = HostFile | { whisperUrl: string };

const response = async (
  input: Download,
  signal?: AbortSignal
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
  const fetchFile = () =>
    fetch(`${host.origin}/files?${query}`, {
      credentials: "include",
      headers: { Authorization: `Bearer ${host.token}` },
      signal,
    });
  let result = await fetchFile();
  if ([401, 403].includes(result.status)) {
    host = await refreshUploadToken(true);
    result = await fetchFile();
  }
  return result;
};
const checked = async (
  input: Download,
  signal?: AbortSignal
): Promise<Response> => {
  const result = await response(input, signal);
  if (!result.ok) throw new Error(`File download failed (${result.status})`);
  return result;
};
export const hostFiles = {
  response,
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
  const bytes = await hostFiles.arrayBuffer(input, options?.signal);
  const mimeType =
    (
      {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        bmp: "image/bmp",
        tif: "image/tiff",
        tiff: "image/tiff",
      } as Record<string, string>
    )[input.filePath.split(".").at(-1)?.toLowerCase() ?? ""] ??
    "application/octet-stream";
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
  const bytes = new Uint8Array(
    await hostFiles.arrayBuffer(input, options?.signal)
  );
  if (bytes.subarray(0, 8192).includes(0)) throw new Error("binary-file");
  // Explicit preview limits still apply; transcripts and exports otherwise read fully.
  const limit = input.maxBytes ?? bytes.length;
  return {
    content: new TextDecoder().decode(bytes.subarray(0, limit)),
    sizeBytes: bytes.length,
    truncated: bytes.length > limit,
  };
};
export const readHostPptx: AppClient["files"]["readPptx"] = async (
  input,
  options
) => {
  const bytes = await hostFiles.arrayBuffer(input, options?.signal);
  const [{ default: JSZip }, { parsePptx }] = await Promise.all([
    import("jszip"),
    import("@abacus-ai/contract/pptx/parser"),
  ]);
  const zip = await JSZip.loadAsync(bytes);
  const entries = new Map<string, Uint8Array>();
  for (const entry of Object.values(zip.files)) {
    if (!entry.dir) entries.set(entry.name, await entry.async("uint8array"));
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
  try {
    return await next();
  } catch (error) {
    const failure = error as {
      code?: string;
      data?: { alternative?: unknown };
    };
    if (failure?.code !== "PAYLOAD_TOO_LARGE") throw error;
    const alternative = failure.data?.alternative;
    if (typeof alternative !== "string" || !alternative.startsWith("/files?"))
      throw error;
    const url = new URL(alternative, "https://host.invalid");
    const filePath = url.searchParams.get("path");
    const hostRoot = url.searchParams.get("hostRoot");
    // Placeholder alternatives require host paging/export support.
    if (!filePath || !hostRoot || /[<>]/.test(filePath + hostRoot)) throw error;
    return JSON.parse(await hostFiles.text({ filePath, hostRoot }, signal));
  }
};
