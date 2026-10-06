import { persistedStore } from "#renderer/lib/continuity/registry";
export const reviewStore = persistedStore<
  Record<string, Record<string, string>>
>("abacusai-bot:abacus.sessions.reviews", () => ({}));
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
