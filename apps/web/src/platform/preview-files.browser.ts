import { hostFiles, type HostFile } from "#renderer/lib/browser/host-files";
export const browserPreview = true;
export const previewBlob = async (
  input: HostFile,
  type: string,
  signal: AbortSignal
) => {
  if ((await hostFiles.size(input, signal)) > 60 * 1024 * 1024)
    throw new Error("Preview exceeds 60 MB");
  const blob = await hostFiles.blob(input, signal);
  return URL.createObjectURL(
    new Blob(
      type === "text/html"
        ? [
            "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'\">",
            blob,
          ]
        : [blob],
      { type }
    )
  );
};
export const previewSize = (input: HostFile, signal: AbortSignal) =>
  hostFiles.size(input, signal);
export const downloadFile = async (input: HostFile) => {
  const link = document.createElement("a");
  link.href = await hostFiles.downloadUrl(input);
  link.download = input.filePath.split("/").at(-1) ?? "";
  link.rel = "noreferrer";
  document.body.append(link);
  link.click();
  link.remove();
};
