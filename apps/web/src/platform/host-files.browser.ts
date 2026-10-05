import { hostFiles } from "#renderer/lib/browser/host-files";
export { browserFileCall } from "#renderer/lib/browser/host-files";
export const fetchHostModel = (whisperUrl: string): Promise<Response> =>
  hostFiles.response({ whisperUrl });
