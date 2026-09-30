interface ClipboardImageItem {
  types: readonly string[];
  getType(type: string): Promise<unknown>;
}

interface ClipboardImageDependencies {
  read(): Promise<ClipboardImageItem[]>;
  toPNG(data: Buffer): Buffer;
  logError(error: unknown): void;
}

/** Keep the attachment contract while using Electron 44's ClipboardItem API. */
export async function readClipboardImage({
  read,
  toPNG,
  logError,
}: ClipboardImageDependencies) {
  try {
    const items = await read();
    for (const item of items) {
      const type = item.types.includes("image/png")
        ? "image/png"
        : item.types.find((type) => type.startsWith("image/"));
      if (type === undefined) continue;
      const blob = (await item.getType(type)) as Blob;
      const bytes = Buffer.from(await blob.arrayBuffer());
      const data = type === "image/png" ? bytes : toPNG(bytes);
      if (data.length === 0) continue;
      return {
        name: `clipboard-${Date.now()}.png`,
        data,
        mimeType: "image/png" as const,
      };
    }
    return null;
  } catch (error) {
    logError(error);
    return null;
  }
}
