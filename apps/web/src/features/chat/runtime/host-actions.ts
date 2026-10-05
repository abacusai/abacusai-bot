import { uploadFiles, viewHostFile } from "#platform/files";
/**
 * What the chat kit asks of the host besides `ai.*` (spec 02 §7.5, §8.6):
 * external links, revealing files, the attach pickers, pasted files and
 * thumbnails. Built from the transport in production; faked in fixtures.
 */
import type { CreditActions } from "#renderer/components/credits-card";
import { creditActionsFor } from "#renderer/components/credits-card/actions";
import type { Transport } from "#renderer/data/transport";
import { creditsTier } from "#renderer/lib/credits";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";

export interface AttachmentContext {
  workspaceId: string;
  sessionId: string;
}
export type ResolveAttachmentContext = () => Promise<AttachmentContext>;

interface PickedPath {
  path: string;
  name: string;
  size?: number;
}

export interface ChatHostActions extends CreditActions {
  openExternal(url: string): Promise<void>;
  accountTier(): Promise<"free" | "basic" | "paid" | "unknown">;
  showItemInFolder(path: string): Promise<void>;
  pickFiles(context?: ResolveAttachmentContext): Promise<PickedPath[] | null>;
  pickFolder(): Promise<string | null>;
  /** Writes pasted blobs under `baseFolder`; returns their absolute paths. */
  savePasted(
    baseFolder: string,
    files: Array<{ name: string; data: Uint8Array<ArrayBuffer> }>,
    context?: ResolveAttachmentContext
  ): Promise<string[]>;
  /** A dropped file's real path, when it has one (spec 00 A.4.4). */
  pathForFile(file: File): string | null;
  readImage(filePath: string, hostRoot: string): Promise<string>;
}

export const hostActionsFor = (transport: Transport): ChatHostActions => {
  const client = transport.client;
  return {
    ...creditActionsFor(transport),
    accountTier: async () => {
      const account = await client.account.abacus();
      return creditsTier(account);
    },
    openExternal: (url) => platformSystem(client).openExternal({ url }),
    showItemInFolder: (path) =>
      IS_ELECTRON
        ? client.system.showItemInFolder({ path })
        : viewHostFile(client, path),
    // Native File objects expose metadata without reading file contents. The
    // preload bridge resolves their paths without the byte-returning picker RPC.
    pickFiles: (context) =>
      new Promise((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.hidden = true;
        const finish = (paths: PickedPath[] | null) => {
          input.remove();
          resolve(paths);
        };
        input.addEventListener("cancel", () => finish(null), { once: true });
        input.addEventListener(
          "change",
          async () => {
            try {
              const files = Array.from(input.files ?? []);
              // Electron reads the picked files in place; browsers upload them.
              const paths = IS_ELECTRON
                ? files.map((file) => {
                    const path = transport.host.getPathForFile?.(file);
                    if (!path)
                      throw new Error(
                        "The host cannot resolve the selected file's path"
                      );
                    return path;
                  })
                : files.length > 0
                  ? await uploadFiles(files, await context?.())
                  : [];
              finish(
                files.length === 0
                  ? null
                  : paths.map((path, i) => ({
                      path,
                      name: files[i]!.name,
                      size: files[i]!.size,
                    }))
              );
            } catch (error) {
              input.remove();
              reject(error);
            }
          },
          { once: true }
        );
        document.body.append(input);
        input.click();
      }),
    pickFolder: () => platformSystem(client).dialog.openFolder(),
    savePasted: async (baseFolder, files, context) =>
      IS_ELECTRON
        ? (await client.files.savePastedTemp({ baseFolder, files })).paths
        : uploadFiles(
            files.map((file) => new File([file.data], file.name)),
            await context?.()
          ),
    pathForFile: (file) => transport.host.getPathForFile?.(file) || null,
    readImage: async (filePath, hostRoot) =>
      (await client.files.readImageAsDataUrl({ filePath, hostRoot })).dataUrl,
  };
};

/** A host that does nothing (gallery, tests). */
export const inertHostActions: ChatHostActions = {
  openExternal: async () => {},
  accountTier: async () => "unknown",
  showItemInFolder: async () => {},
  pickFiles: async () => null,
  pickFolder: async () => null,
  savePasted: async () => [],
  pathForFile: () => null,
  readImage: async () => "",
};
