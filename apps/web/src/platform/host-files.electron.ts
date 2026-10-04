export const browserFileCall = (
  _path: readonly string[],
  _input: unknown,
  next: () => Promise<unknown>,
  _signal?: AbortSignal
): Promise<unknown> => next();
export const fetchHostModel = (_url: string): Promise<Response> => {
  throw new Error("Browser model download unavailable on Electron");
};
