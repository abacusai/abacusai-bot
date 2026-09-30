import type { FilesEvent } from "#shared/contract";

import {
  conflict,
  forbidden,
  notFound,
  unwrapResult,
  type RpcError,
} from "../errors";
import { impl, isType, onIpcEvents, stream } from "./impl";

/** The host-file readers' failure codes (services/workspace/host-path.ts). */
const hostFileError =
  (filePath: string) =>
  (reason: string): RpcError =>
    reason === "not-found"
      ? notFound("file", filePath)
      : reason === "outside-root"
        ? forbidden(reason)
        : conflict(reason);

export const filesRouter = impl.files.router({
  treeRoot: impl.files.treeRoot.handler(({ context }) =>
    context.deps.serviceHost.getFileTreeRoot()
  ),
  treeChildren: impl.files.treeChildren.handler(({ input, context }) =>
    context.deps.serviceHost.getFileTreeChildren(input.directoryPath)
  ),
  search: impl.files.search.handler(({ input, context }) =>
    context.deps.serviceHost.searchFiles(input.query)
  ),
  rename: impl.files.rename.handler(async ({ input, context }) => {
    unwrapResult(
      await context.deps.serviceHost.renameLocalFile(
        input.fromPath,
        input.toPath
      )
    );
  }),
  trash: impl.files.trash.handler(async ({ input, context }) => {
    unwrapResult(await context.deps.serviceHost.trashLocalFile(input.filePath));
  }),
  savePastedTemp: impl.files.savePastedTemp.handler(
    async ({ input, context }) => {
      const { dir, paths } = unwrapResult(
        await context.deps.app.savePastedTempFiles(
          input.baseFolder,
          input.files
        )
      );
      return { dir: dir ?? "", paths: paths ?? [] };
    }
  ),
  readImageAsDataUrl: impl.files.readImageAsDataUrl.handler(
    async ({ input, context }) => {
      const result = unwrapResult(
        await context.deps.app.readImageAsDataUrl(input),
        hostFileError(input.filePath)
      );
      return {
        dataUrl: result.dataUrl ?? "",
        mimeType: result.mimeType ?? "",
        sizeBytes: result.sizeBytes ?? 0,
      };
    }
  ),
  readText: impl.files.readText.handler(async ({ input, context }) => {
    const result = unwrapResult(
      await context.deps.app.readFileAsText(input),
      hostFileError(input.filePath)
    );
    return {
      content: result.content ?? "",
      sizeBytes: result.sizeBytes ?? 0,
      truncated: result.truncated === true,
    };
  }),
  readPptx: impl.files.readPptx.handler(async ({ input, context }) => {
    const result = await context.deps.app.readPptx(input);
    if (result.success === false)
      throw hostFileError(input.filePath)(result.error);
    return { deck: result.deck, sizeBytes: result.sizeBytes };
  }),
  events: impl.files.events.handler(({ context, signal }) =>
    stream<FilesEvent>({
      path: "files.events",
      context,
      signal,
      attach: onIpcEvents(
        context,
        isType("file-tree-root-updated", "preview-open"),
        (event): FilesEvent | null =>
          event.type === "file-tree-root-updated"
            ? { type: "tree-root-changed" }
            : event.type === "preview-open"
              ? {
                  type: "preview-open",
                  path: event.path,
                  ...(event.conversationKey == null
                    ? {}
                    : { conversationKey: event.conversationKey }),
                }
              : null
      ),
      // A root change is an invalidation notice; a preview is an action.
      coalesceKey: (event) =>
        event.type === "tree-root-changed" ? "tree-root-changed" : null,
    })
  ),
});
