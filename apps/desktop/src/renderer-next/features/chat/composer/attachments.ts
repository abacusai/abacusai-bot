/**
 * Attachments (spec 02 §8.6): a picked or dropped file with a real path is
 * used directly; pasted data is saved under the attachments base first.
 * The extension rule is today's (`chat-panel.tsx:1403-1410`).
 */
import type { ChatHostActions } from "../runtime/host-actions";
import { updateDraft, type DraftAttachment } from "./draft-store";

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

let counter = 0;
const nextId = (): string => `att-${Date.now().toString(36)}-${++counter}`;

const patch = (
  threadId: string,
  id: string,
  change: Partial<DraftAttachment>
): void =>
  updateDraft(threadId, (draft) => ({
    ...draft,
    attachments: draft.attachments.map((a) =>
      a.id === id ? { ...a, ...change } : a
    ),
  }));

export const addPaths = (
  threadId: string,
  files: Array<{ path: string; name?: string; size?: number }>
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
        ...(file.size != null ? { size: file.size } : {}),
      })),
    ],
  }));

/** Dropped or pasted `File`s: real paths directly, blobs saved first. */
export const addFiles = async (
  threadId: string,
  files: readonly File[],
  host: ChatHostActions,
  attachmentsBase: string | null
): Promise<void> => {
  for (const file of files) {
    const path = host.pathForFile(file);
    if (path != null) {
      addPaths(threadId, [{ path, name: file.name, size: file.size }]);
      continue;
    }
    if (attachmentsBase == null) continue;
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
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const [saved] = await host.savePasted(attachmentsBase, [
        { name: pastedName(id, file), data },
      ]);
      if (saved == null) throw new Error("not saved");
      patch(threadId, id, { path: saved, state: "done" });
    } catch (error) {
      patch(threadId, id, {
        state: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};

export const removeAttachment = (threadId: string, id: string): void =>
  updateDraft(threadId, (draft) => {
    const gone = draft.attachments.find((a) => a.id === id);
    if (gone?.preview != null) URL.revokeObjectURL?.(gone.preview);
    return {
      ...draft,
      attachments: draft.attachments.filter((a) => a.id !== id),
    };
  });

export const formatSize = (bytes: number | undefined): string => {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
