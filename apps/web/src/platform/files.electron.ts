export const uploadFiles: typeof import("#renderer/lib/browser/files").uploadFiles =
  async () => {
    throw new Error("Browser upload unavailable on Electron");
  };
export const viewHostFile: typeof import("#renderer/lib/browser/files").viewHostFile =
  async () => {
    throw new Error("Browser file viewer unavailable on Electron");
  };

export const pickUploadFiles: typeof import("#renderer/lib/browser/files").pickUploadFiles =
  async () => null;
export const pickHostPaths: typeof import("#renderer/lib/browser/files").pickHostPaths =
  async () => null;
