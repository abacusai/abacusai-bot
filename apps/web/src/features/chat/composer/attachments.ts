/**
 * Attachments (spec 02 §8.6): a picked or dropped file with a real path is
 * used directly; pasted data is saved under the attachments base first.
 * The extension rule is today's (`chat-panel.tsx:1403-1410`).
 */
import { UPLOAD_LIMITS } from "@abacus-ai/contract/contract/files";

import {
  draftStore,
  updateDraft,
  type DraftAttachment,
} from "#renderer/lib/continuity/composer-drafts";
import { i18n } from "#renderer/lib/i18n";

import type { ChatHostActions } from "../runtime/host-actions";
import { relativeFilePath, isUploadJunk, droppedFiles } from "./dropped-files";

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

/** A pasted file's name on disk: its own extension, else one from its type. */
const pastedName = (
  id: string,
  file: { name: string; type: string }
): string => {
  const own = /\.([A-Za-z0-9]{1,8})$/.exec(file.name)?.[1];
  const ext =
    own ??
    MIME_EXT[file.type] ??
    file.type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ??
    "bin";
  return `${id}.${ext || "bin"}`;
};

import { attachmentRetries as retries } from "#renderer/lib/continuity/attachment-retries";
let counter = 0;
const nextId = (): string => `att-${Date.now().toString(36)}-${++counter}`;

const patch = (
  threadId: string,
  id: string,
  change: Partial<DraftAttachment>
): void => {
  if (!draftStore.state[threadId]?.attachments.some((a) => a.id === id)) return;
  updateDraft(threadId, (draft) => ({
    ...draft,
    attachments: draft.attachments.map((a) =>
      a.id === id ? { ...a, ...change } : a
    ),
  }));
};

export const addPaths = (
  threadId: string,
  files: Array<{
    path: string;
    name?: string;
    size?: number;
    mimeType?: string;
    kind?: "file" | "folder";
    count?: number;
    source?: "computer" | "vm";
  }>
): void =>
  updateDraft(threadId, (draft) => ({
    ...draft,
    attachments: [
      ...draft.attachments,
      ...files.map((file): DraftAttachment => ({
        id: nextId(),
        name: file.name ?? file.path.split(/[\\/]/).at(-1) ?? file.path,
        path: file.path,
        state: "done",
        ...(file.source ? { source: file.source } : {}),
        ...(file.size != null ? { size: file.size } : {}),
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        ...(file.kind ? { kind: file.kind, count: file.count } : {}),
      })),
    ],
  }));

/** Dropped or pasted `File`s: real paths directly, blobs saved first. */
export const addFiles = async (
  threadId: string,
  files: readonly File[],
  host: ChatHostActions,
  attachmentsBase: string | null,
  context?: import("../runtime/host-actions").ResolveAttachmentContext
): Promise<void> => {
  if (host.uploadFile && files.length) {
    await prepareAttachments(
      threadId,
      async () => [...files],
      host,
      attachmentsBase,
      context
    );
    return;
  }
  for (const file of files) {
    const path = host.pathForFile(file);
    if (path != null) {
      addPaths(threadId, [
        { path, name: file.name, size: file.size, mimeType: file.type },
      ]);
      continue;
    }
    if (attachmentsBase == null) {
      updateDraft(threadId, (draft) => ({
        ...draft,
        attachments: [
          ...draft.attachments,
          {
            id: nextId(),
            name: file.name,
            path: null,
            state: "error",
            error: i18n.t("chat.composer.pasteUnavailable"),
          },
        ],
      }));
      continue;
    }
    const id = nextId();
    const preview =
      file.type.startsWith("image/") &&
      typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(file)
        : undefined;
    updateDraft(threadId, (draft) => ({
      ...draft,
      attachments: [
        ...draft.attachments,
        {
          id,
          name: file.name || pastedName(id, file),
          path: null,
          state: "uploading",
          size: file.size,
          mimeType: file.type,
          ...(preview != null ? { preview } : {}),
        },
      ],
    }));
    const upload = async () => {
      patch(threadId, id, { state: "uploading", error: undefined });
      try {
        host.validateUpload?.(file);
        const data = new Uint8Array(await file.arrayBuffer());
        const [saved] = await host.savePasted(
          attachmentsBase,
          [{ name: pastedName(id, file), data }],
          context
        );
        if (saved == null) throw new Error("not saved");
        patch(threadId, id, { path: saved, state: "done" });
        retries.delete(`${threadId}:${id}`);
      } catch (error) {
        patch(threadId, id, {
          state: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    retries.set(`${threadId}:${id}`, upload);
    await upload();
  }
};

export const addDroppedFiles = (
  threadId: string,
  transfer: DataTransfer,
  host: ChatHostActions,
  attachmentsBase: string | null,
  context?: import("../runtime/host-actions").ResolveAttachmentContext
): Promise<void> =>
  prepareAttachments(
    threadId,
    () => droppedFiles(transfer),
    host,
    attachmentsBase,
    context
  );

const preparing = new Map<string, AbortController>();
const prepareAttachments = async (
  threadId: string,
  read: () => Promise<File[]>,
  host: ChatHostActions,
  attachmentsBase: string | null,
  context?: import("../runtime/host-actions").ResolveAttachmentContext
): Promise<void> => {
  const id = nextId();
  const controller = new AbortController();
  preparing.set(id, controller);
  updateDraft(threadId, (draft) => ({
    ...draft,
    attachments: [
      ...draft.attachments,
      {
        id,
        name: i18n.t("web.files.upload"),
        path: null,
        state: "uploading",
        source: "computer",
      },
    ],
  }));
  try {
    const files = await read();
    if (controller.signal.aborted) return;
    if (host.uploadFile)
      await addUploads(threadId, files, host, context, controller.signal, () =>
        removeAttachment(threadId, id)
      );
    else await addFiles(threadId, files, host, attachmentsBase, context);
  } catch (error) {
    if (!controller.signal.aborted) {
      patch(threadId, id, {
        state: "error",
        error:
          error instanceof Error
            ? error.message
            : i18n.t("web.files.uploadFailed"),
      });
      preparing.delete(id);
      return;
    }
  } finally {
    if (preparing.has(id)) removeAttachment(threadId, id);
  }
};

export const removeAttachment = (threadId: string, id: string): void => {
  preparing.get(id)?.abort();
  preparing.delete(id);
  uploads.get(id)?.controller.abort();
  uploads.delete(id);
  updateDraft(threadId, (draft) => {
    retries.delete(`${threadId}:${id}`);
    const gone = draft.attachments.find((a) => a.id === id);
    if (gone?.preview != null) URL.revokeObjectURL?.(gone.preview);
    return {
      ...draft,
      attachments: draft.attachments.filter((a) => a.id !== id),
    };
  });
};

export const formatSize = (bytes: number | undefined): string => {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const retryAttachment = async (
  threadId: string,
  id: string,
  host: ChatHostActions,
  context?: import("../runtime/host-actions").ResolveAttachmentContext
): Promise<void> => {
  const upload = retries.get(`${threadId}:${id}`);
  if (upload) return upload();
  try {
    const [picked] = (await host.pickFiles(context)) ?? [];
    if (picked)
      patch(threadId, id, { ...picked, state: "done", error: undefined });
  } catch (error) {
    patch(threadId, id, { state: "error", error: String(error) });
  }
};

const uploads = new Map<
  string,
  { controller: AbortController; run: () => Promise<void> }
>();
const addUploads = async (
  threadId: string,
  originals: readonly File[],
  host: ChatHostActions,
  context?: import("../runtime/host-actions").ResolveAttachmentContext,
  signal?: AbortSignal,
  prepared?: () => void
): Promise<void> => {
  const selected = originals.filter((file) => !isUploadJunk(file));
  const skipped = originals.length - selected.length;
  let files = selected;
  if (
    selected.length > 200 ||
    selected.reduce((size, file) => size + file.size, 0) > 100 * 1024 * 1024 ||
    skipped > 0
  ) {
    const { confirmUpload } = await import("#renderer/lib/browser/host-dialog");
    const include = await confirmUpload(
      selected.length,
      formatSize(selected.reduce((size, file) => size + file.size, 0)),
      skipped
    );
    if (include === null || signal?.aborted) return;
    if (include) files = [...originals];
  }
  const total = files.reduce((size, file) => size + file.size, 0);
  const limitError =
    files.length > UPLOAD_LIMITS.fileCount ||
    total > UPLOAD_LIMITS.totalBytes ||
    files.some((file) => file.size > UPLOAD_LIMITS.fileBytes);
  if (limitError) {
    updateDraft(threadId, (draft) => ({
      ...draft,
      attachments: [
        ...draft.attachments,
        {
          id: nextId(),
          name: i18n.t("web.files.upload"),
          path: null,
          state: "error",
          source: "computer",
          error: i18n.t("web.files.uploadLimits"),
        },
      ],
    }));
    return;
  }
  const groups = new Map<string, File[]>();
  for (const file of files) {
    const relative = relativeFilePath(file);
    const key = relative.includes("/") ? relative.split("/")[0]! : nextId();
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  if (signal?.aborted) return;
  let resolvedContext: ReturnType<NonNullable<typeof context>> | undefined;
  const batch = crypto.randomUUID();
  const jobs: Array<() => Promise<void>> = [];
  for (const [name, group] of groups) {
    const folder = relativeFilePath(group[0]!).includes("/");
    const id = nextId();
    const preview =
      !folder && group[0]!.type.startsWith("image/")
        ? URL.createObjectURL(group[0]!)
        : undefined;
    updateDraft(threadId, (draft) => ({
      ...draft,
      attachments: [
        ...draft.attachments,
        {
          id,
          name: folder ? name : group[0]!.name,
          path: null,
          state: "uploading",
          source: "computer",
          kind: folder ? "folder" : "file",
          progress: 0,
          size: group.reduce((sum, file) => sum + file.size, 0),
          ...(folder
            ? {
                files: group.map((file) => ({
                  name: relativeFilePath(file),
                  size: file.size,
                })),
              }
            : {}),
          ...(preview ? { preview } : {}),
        },
      ],
    }));
    const uploadBatch = folder ? batch : `${batch}-${id}`;
    const job = {
      controller: new AbortController(),
      running: false,
      run: async (): Promise<void> => {
        if (!uploads.has(id) || job.running) return;
        job.running = true;
        job.controller = new AbortController();
        patch(threadId, id, {
          state: "uploading",
          error: undefined,
          progress: 0,
        });
        try {
          if (!context) throw new Error(i18n.t("web.files.selectSession"));
          const resolved = await (resolvedContext ??= context());
          if (job.controller.signal.aborted) return;
          let path: string | undefined;
          for (const [index, file] of group.entries()) {
            const relativePath = relativeFilePath(file);
            const saved = await host.uploadFile!(file, resolved, {
              signal: job.controller.signal,
              batch: uploadBatch,
              relativePath,
              progress: (percent) =>
                patch(threadId, id, {
                  progress: Math.floor(
                    ((index + percent / 100) / group.length) * 100
                  ),
                }),
            });
            path ??= folder
              ? saved.slice(0, saved.length - relativePath.length) + name
              : saved;
          }
          patch(threadId, id, {
            path: path ?? null,
            state: "done",
            progress: 100,
          });
          uploads.delete(id);
          retries.delete(`${threadId}:${id}`);
        } catch (error) {
          if (job.controller.signal.aborted) return;
          patch(threadId, id, {
            state: "error",
            error:
              error instanceof Error
                ? error.message
                : i18n.t("web.files.uploadFailed"),
          });
        } finally {
          job.running = false;
        }
      },
    };
    uploads.set(id, job);
    retries.set(`${threadId}:${id}`, job.run);
    jobs.push(job.run);
  }
  prepared?.();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        if (job) await job();
      }
    })
  );
};
