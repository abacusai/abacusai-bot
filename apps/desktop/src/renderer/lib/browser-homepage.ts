import { durableStorage } from "./durable-storage";

export const DEFAULT_BROWSER_HOMEPAGE = "https://www.google.com";

const STORAGE_KEY = "browser.homepage";

export function normalizeBrowserHomepage(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return DEFAULT_BROWSER_HOMEPAGE;

  try {
    const url = new URL(
      /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
    );
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function getBrowserHomepage(): string {
  try {
    return (
      normalizeBrowserHomepage(durableStorage.getItem(STORAGE_KEY) ?? "") ??
      DEFAULT_BROWSER_HOMEPAGE
    );
  } catch {
    return DEFAULT_BROWSER_HOMEPAGE;
  }
}

export function setBrowserHomepage(value: string): string | null {
  const normalized = normalizeBrowserHomepage(value);
  if (normalized == null) return null;
  try {
    durableStorage.setItem(STORAGE_KEY, normalized);
  } catch {
    // The current renderer still uses the value even if storage is unavailable.
  }
  return normalized;
}
