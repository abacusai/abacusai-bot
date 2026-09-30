import { Store } from "@tanstack/react-store";

import type { AppClient } from "#next/data/transport/types";
import type {
  BrowserRuntimeLease,
  BrowserRuntimeBounds,
} from "#shared/contracts";

export interface NativeCandidate {
  id: string;
  lease: BrowserRuntimeLease;
  bounds(): BrowserRuntimeBounds;
  visible(): boolean;
  blocked(): boolean;
}
/** Serializes the window's single native presentation and recovers after every failed RPC. */
export const createNativePresenter = (
  runtime: AppClient["browser"]["runtime"]
) => {
  const candidates = new Map<string, NativeCandidate>();
  const captures = new Store<Record<string, string>>({});
  const owner = new Store<string | null>(null);
  let desired: string | null = null;
  let current: NativeCandidate | null = null;
  let lastBounds = "";
  let revision = 0;
  let chain = Promise.resolve();
  const eligible = (c: NativeCandidate | undefined): c is NativeCandidate =>
    c != null && c.visible() && !c.blocked();
  const safe = async <T>(call: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await call();
    } catch (error) {
      console.warn("Native presentation failed", error);
      return undefined;
    }
  };
  const refresh = (): Promise<void> => {
    const requested = ++revision;
    chain = chain
      .catch(() => {})
      .then(async () => {
        if (requested !== revision) return;
        const next = candidates.get(desired ?? "");
        const chosen = eligible(next)
          ? next
          : ([...candidates.values()].find(eligible) ?? null);
        const old = current;
        if (old && (old !== chosen || !eligible(old))) {
          const capture = await safe(async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                runtime.capture(old.lease),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error("Browser capture deadline")),
                    500
                  );
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          });
          if (capture?.dataUrl && candidates.get(old.id) === old)
            captures.setState((s) => ({ ...s, [old.id]: capture.dataUrl! }));
          await safe(() =>
            runtime.hide({ lease: old.lease, presentationId: old.id })
          );
          current = null;
          owner.setState(() => null);
          lastBounds = "";
        }
        if (
          requested !== revision ||
          !chosen ||
          candidates.get(chosen.id) !== chosen ||
          !eligible(chosen)
        )
          return;
        const bounds = Object.fromEntries(
          Object.entries(chosen.bounds()).map(([k, v]) => [k, Math.round(v)])
        ) as unknown as BrowserRuntimeBounds;
        const signature = JSON.stringify(bounds);
        if (current !== chosen || signature !== lastBounds) {
          const presented = await safe(() =>
            runtime.present({
              lease: chosen.lease,
              presentationId: chosen.id,
              bounds,
            })
          );
          if (
            presented &&
            (requested !== revision ||
              candidates.get(chosen.id) !== chosen ||
              !eligible(chosen))
          ) {
            await safe(() =>
              runtime.hide({ lease: chosen.lease, presentationId: chosen.id })
            );
            return;
          }
          if (presented && requested === revision) {
            current = chosen;
            owner.setState(() => chosen.id);
            lastBounds = signature;
          }
        }
      });
    return chain;
  };
  return {
    captures,
    owner,
    refresh,
    activate(id: string) {
      desired = id;
      return refresh();
    },
    register(candidate: NativeCandidate) {
      candidates.set(candidate.id, candidate);
      desired = candidate.id;
      void refresh();
      return () => {
        if (candidates.get(candidate.id) === candidate)
          candidates.delete(candidate.id);
        void refresh();
      };
    },
  };
};
export type NativePresenter = ReturnType<typeof createNativePresenter>;
const presenters = new WeakMap<AppClient, NativePresenter>();
export const nativePresenterFor = (client: AppClient): NativePresenter => {
  let presenter = presenters.get(client);
  if (!presenter) {
    presenter = createNativePresenter(client.browser.runtime);
    presenters.set(client, presenter);
  }
  return presenter;
};
