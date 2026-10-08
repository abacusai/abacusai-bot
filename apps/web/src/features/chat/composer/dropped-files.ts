const relativePaths = new WeakMap<File, string>();
export const relativeFilePath = (file: File): string =>
  relativePaths.get(file) || file.webkitRelativePath || file.name;
const junk = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  "__pycache__",
  ".pytest_cache",
  ".venv",
]);
export const isUploadJunk = (file: File): boolean =>
  relativeFilePath(file)
    .split("/")
    .some((part) => junk.has(part));
export const droppedFiles = async (transfer: DataTransfer): Promise<File[]> => {
  const files: File[] = [];
  let regular = 0;
  let skipped = 0;
  const walk = async (
    entry: FileSystemEntry,
    prefix: string
  ): Promise<void> => {
    const path = `${prefix}${entry.name}`;
    const ignored = path.split("/").some((part) => junk.has(part));
    if (regular >= 1001 || (ignored && skipped >= 1001)) return;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject)
      );
      relativePaths.set(file, path);
      files.push(file);
      if (ignored) skipped++;
      else regular++;
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      while (regular < 1001 && (!ignored || skipped < 1001)) {
        const entries = await new Promise<FileSystemEntry[]>(
          (resolve, reject) => reader.readEntries(resolve, reject)
        );
        if (!entries.length) break;
        for (const child of entries) await walk(child, `${path}/`);
      }
    }
  };
  const entries = Array.from(transfer.items ?? [])
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => !!entry);
  if (!entries.length) return Array.from(transfer.files);
  for (const entry of entries) await walk(entry, "");
  return files;
};
