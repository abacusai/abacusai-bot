/** Native window identity, independent of WebContents registration and renderer swaps. */
const windows = new WeakSet<object>();
export const rememberNotchWindow = (window: object): void => {
  windows.add(window);
};
export const isNotchWindow = (window: object): boolean => windows.has(window);
