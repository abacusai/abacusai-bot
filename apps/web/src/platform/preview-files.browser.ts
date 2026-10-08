import { hostFiles, type HostFile } from "#renderer/lib/browser/host-files";
export const browserPreview = true;
export const previewBlob = async (
  input: HostFile,
  type: string,
  signal: AbortSignal
) => {
  const blob = await hostFiles.blob(input, signal);
  return URL.createObjectURL(new Blob([blob], { type }));
};
export const previewSize = (input: HostFile, signal: AbortSignal) =>
  hostFiles.size(input, signal);
export const downloadFile = async (input: HostFile) => {
  const blob = await hostFiles.blob(input);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = input.filePath.split("/").at(-1) ?? "";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};
