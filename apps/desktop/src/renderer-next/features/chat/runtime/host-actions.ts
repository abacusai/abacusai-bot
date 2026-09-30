/**
 * What the chat kit asks of the host besides `ai.*` (spec 02 §7.5, §8.6):
 * external links, revealing files, the attach pickers, pasted files and
 * thumbnails. Built from the transport in production; faked in fixtures.
 */
import type { Transport } from "#next/data/transport";

interface PickedPath {
  path: string;
  name: string;
  size?: number;
}

export interface ChatHostActions {
  openExternal(url: string): Promise<void>;
  accountTier(): Promise<"free" | "basic" | "paid" | "unknown">;
  showItemInFolder(path: string): Promise<void>;
  pickFiles(): Promise<PickedPath[] | null>;
  pickFolder(): Promise<string | null>;
  /** Writes pasted blobs under `baseFolder`; returns their absolute paths. */
  savePasted(
    baseFolder: string,
    files: Array<{ name: string; data: Uint8Array<ArrayBuffer> }>
  ): Promise<string[]>;
  /** A dropped file's real path, when it has one (spec 00 A.4.4). */
  pathForFile(file: File): string | null;
  readImage(filePath: string, hostRoot: string): Promise<string>;
}

export const hostActionsFor = (transport: Transport): ChatHostActions => {
  const client = transport.client;
  return {
    accountTier: async () => {
      const account = await client.account.abacus();
      const tier = (
        account?.subscription_tier ??
        account?.plan ??
        ""
      ).toLowerCase();
      return tier === "free"
        ? "free"
        : tier === "basic"
          ? "basic"
          : ["pro", "max", "enterprise", "paid"].includes(tier)
            ? "paid"
            : "unknown";
    },
    openExternal: (url) => client.system.openExternal({ url }),
    showItemInFolder: (path) => client.system.showItemInFolder({ path }),
    // Native File objects expose metadata without reading file contents. The
    // preload bridge resolves their paths without the byte-returning picker RPC.
    pickFiles: () =>
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
          () => {
            try {
              const paths = Array.from(input.files ?? []).map((file) => {
                const path = transport.host.getPathForFile?.(file);
                if (!path)
                  throw new Error(
                    "The host cannot resolve the selected file's path"
                  );
                return { path, name: file.name, size: file.size };
              });
              finish(paths.length === 0 ? null : paths);
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
    pickFolder: () => client.system.dialog.openFolder(),
    savePasted: async (baseFolder, files) =>
      (await client.files.savePastedTemp({ baseFolder, files })).paths,
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
