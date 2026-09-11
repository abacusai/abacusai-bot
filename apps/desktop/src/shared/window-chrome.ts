export type WindowChromeMetrics = {
  titlebarHeight: number;
  contentStartInset: number;
};

/**
 * Native and renderer title-bar geometry must come from the same values. The
 * macOS inset clears the traffic-light cluster for the first renderer control.
 */
export const MACOS_TRAFFIC_LIGHT_POSITION = { x: 16, y: 13 } as const;

const MACOS_METRICS: WindowChromeMetrics = {
  titlebarHeight: 40,
  contentStartInset: 84,
};

const WINDOWS_METRICS: WindowChromeMetrics = {
  titlebarHeight: 32,
  contentStartInset: 16,
};

const LINUX_METRICS: WindowChromeMetrics = {
  titlebarHeight: 40,
  contentStartInset: 16,
};

export function windowChromeMetrics(platform: string): WindowChromeMetrics {
  if (platform === "darwin") return MACOS_METRICS;
  if (platform === "win32") return WINDOWS_METRICS;
  return LINUX_METRICS;
}
