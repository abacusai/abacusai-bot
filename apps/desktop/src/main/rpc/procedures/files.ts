import type { FilesEvent } from "@abacus-ai/contract/contract";

import {
  conflict,
  forbidden,
  notFound,
  unwrapResult,
  unsupported,
  type RpcError,
} from "../errors";
import { impl, isType, onIpcEvents, stream } from "./impl";

/** The host-file readers' failure codes (services/workspace/host-path.ts). */
export const hostFileError =
  (filePath: string) =>
  (reason: string): RpcError =>
    reason === "not-found"
      ? notFound("file", filePath)
      : reason === "outside-root"
        ? forbidden(reason)
        : conflict(reason);

/**
 * With `checkout`, the checkout-aware service (spec 04 §26.4 a); without it,
 * the legacy active-workspace method the old renderer's IPC handler calls.
 */
export const filesRouter = impl.files.router({
  listDirectory: impl.files.listDirectory.handler(({ input, context }) => {
    const list = context.deps.app.listDirectory;
    if (!list) throw unsupported("files.listDirectory");
    return list(input.path);
  }),
  mkdir: impl.files.mkdir.handler(({ input, context }) => {
    const mkdir = context.deps.app.mkdir;
    if (!mkdir) throw unsupported("files.mkdir");
    return mkdir(input.path, input.name);
  }),
  treeRoot: impl.files.treeRoot.handler(({ input, context }) =>
    input?.checkout == null
      ? context.deps.serviceHost.getFileTreeRoot()
      : context.deps.serviceHost.checkouts.treeRoot(input.checkout)
  ),
  treeChildren: impl.files.treeChildren.handler(({ input, context }) =>
    input.checkout == null
      ? context.deps.serviceHost.getFileTreeChildren(input.directoryPath)
      : context.deps.serviceHost.checkouts.treeChildren(
          input.checkout,
          input.directoryPath
        )
  ),
  search: impl.files.search.handler(({ input, context }) =>
    input.checkout == null
      ? context.deps.serviceHost.searchFiles(input.query)
      : context.deps.serviceHost.checkouts.search(input.checkout, input.query)
  ),
  rename: impl.files.rename.handler(async ({ input, context }) => {
    const { serviceHost } = context.deps;
    unwrapResult(
      input.checkout == null
        ? await serviceHost.renameLocalFile(input.fromPath, input.toPath)
        : await serviceHost.checkouts.rename(
            input.checkout,
            input.fromPath,
            input.toPath
          )
    );
  }),
  trash: impl.files.trash.handler(async ({ input, context }) => {
    const { serviceHost } = context.deps;
    unwrapResult(
      input.checkout == null
        ? await serviceHost.trashLocalFile(input.filePath)
        : await serviceHost.checkouts.trash(input.checkout, input.filePath)
    );
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
      attach: (push) => {
        const { serviceHost } = context.deps;
        const legacy = onIpcEvents(
          context,
          isType("file-tree-root-updated", "preview-open"),
          (event): FilesEvent | null => {
            if (event.type === "file-tree-root-updated") {
              // The legacy event is the active workspace's primary checkout.
              const key = serviceHost.activeCheckoutKey();
              return key == null
                ? { type: "tree-root-changed" }
                : { type: "tree-root-changed", checkoutKey: key };
            }
            return event.type === "preview-open"
              ? {
                  type: "preview-open",
                  path: event.path,
                  ...(event.conversationKey == null
                    ? {}
                    : { conversationKey: event.conversationKey }),
                }
              : null;
          }
        )(push);
        const watched = serviceHost.checkouts.onTreeChanged((checkoutKey) =>
          push({ type: "tree-root-changed", checkoutKey })
        );
        return () => {
          legacy();
          watched();
        };
      },
      // A root change is an invalidation notice per checkout; a preview is
      // an action.
      coalesceKey: (event) =>
        event.type === "tree-root-changed"
          ? `tree-root-changed:${event.checkoutKey ?? ""}`
          : null,
    })
  ),
});
