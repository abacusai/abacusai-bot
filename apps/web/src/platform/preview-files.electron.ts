export const browserPreview = false;
export const previewBlob = async (
  _input: { filePath: string; hostRoot: string },
  _type: string,
  _signal: AbortSignal
): Promise<string> => {
  throw new Error("Browser preview unavailable");
};
export const previewSize = async (
  _input: { filePath: string; hostRoot: string },
  _signal: AbortSignal
): Promise<number> => {
  throw new Error("Browser preview unavailable");
};
export const downloadFile = async (_input: {
  filePath: string;
  hostRoot: string;
}): Promise<void> => {
  throw new Error("Browser download unavailable");
};
