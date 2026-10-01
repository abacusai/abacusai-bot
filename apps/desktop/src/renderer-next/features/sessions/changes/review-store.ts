import { Store } from "@tanstack/react-store";

import { bindContinuityStore } from "#next/lib/continuity/registry";
const KEY = "abacus.sessions.reviews";
const load = (): Record<string, Record<string, string>> => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
};
export const reviewStore = new Store(load());
reviewStore.subscribe((s) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
});
export const reviewKey = (path: string, scope: string): string =>
  JSON.stringify([path, scope]);
export const keepChange = (
  id: string,
  path: string,
  scope: string,
  fingerprint: string
): void =>
  reviewStore.setState((s) => ({
    ...s,
    [id]: { ...s[id], [reviewKey(path, scope)]: fingerprint },
  }));
export const isReviewed = (
  id: string,
  path: string,
  scope: string,
  fingerprint: string | undefined
): boolean =>
  fingerprint !== undefined &&
  reviewStore.state[id]?.[reviewKey(path, scope)] === fingerprint;

bindContinuityStore(KEY, {
  read: () => reviewStore.state,
  write: (value) =>
    reviewStore.setState(() => value as Record<string, Record<string, string>>),
});
