import { callApps } from "#renderer/features/shell/connect/services";
import type { RouterContext } from "#renderer/router";

let unmount = () => {};
let peers: BroadcastChannel | undefined;
/** Stop the mounted app before disposing its queries and collections. */
export const installSignOutUnmount = (stop: () => void): void => {
  unmount = stop;
};

/** Bot state only: the website shares this origin and owns its session cookies. */
export const clearBotStorage = (): void => {
  for (const getStorage of [() => localStorage, () => sessionStorage]) {
    try {
      const storage = getStorage();
      for (const key of Object.keys(storage)) {
        if (
          key.startsWith("abacusai-bot:") ||
          key === "tsr-scroll-restoration-v1_3"
        )
          storage.removeItem(key);
      }
    } catch {
      // Blocked storage has no readable account state to carry to another user.
    }
  }
};

const leavePage = () => location.replace(import.meta.env.BASE_URL);

/** Every tab using this website session must drop its live host socket too. */
export const installSignOutPeers = (context: RouterContext): (() => void) => {
  if (typeof BroadcastChannel === "undefined") return () => {};
  peers?.close();
  peers = new BroadcastChannel("abacusai-bot:sign-out");
  peers.onmessage = ({ data }) => {
    if (data === "signed-out") void finishSignOut(context, leavePage);
  };
  return () => {
    peers?.close();
    peers = undefined;
  };
};

export const webSignOut = async (
  context: Pick<RouterContext, "transport" | "db" | "queryClient">,
  leave = leavePage
): Promise<void> => {
  // Only the website can invalidate its HttpOnly session and blacklist it.
  // A rejected or timed-out logout keeps the app intact for a visible retry.
  await callApps("signOut", {});
  peers?.postMessage("signed-out");
  await finishSignOut(context, leave);
};

const finishSignOut = async (
  {
    transport,
    db,
    queryClient,
  }: Pick<RouterContext, "transport" | "db" | "queryClient">,
  leave: () => void
): Promise<void> => {
  unmount();
  db.stop();
  transport.close();
  await queryClient.cancelQueries();
  queryClient.clear();
  await Promise.allSettled(
    Object.values(db.collections).map((collection) => collection.cleanup())
  );
  clearBotStorage();
  // Session stores flush on pagehide; remove those final writes too.
  window.addEventListener("pagehide", clearBotStorage, { once: true });
  // A new document drops module stores, tokens, timers and pending handoffs.
  // The identity service now refuses the invalidated website session.
  leave();
};
