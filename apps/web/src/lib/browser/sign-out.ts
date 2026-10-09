import { callApps } from "#renderer/features/shell/connect/services";
import { webSignInHref } from "#renderer/lib/navigation/web-sign-in";
import type { RouterContext } from "#renderer/router";

const SIGN_OUT_CHANNEL = "abacusai-bot:sign-out";

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
  peers = new BroadcastChannel(SIGN_OUT_CHANNEL);
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

/**
 * Sign-out with no app mounted (the phone screens, a refusal page): the
 * website session, other tabs and this browser's bot data, then `leave`.
 */
export const signOutWithoutApp = async (leave = leavePage): Promise<void> => {
  await callApps("signOut", {});
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(SIGN_OUT_CHANNEL);
    channel.postMessage("signed-out");
    channel.close();
  }
  clearBotStorage();
  window.addEventListener("pagehide", clearBotStorage, { once: true });
  leave();
};

/** Signs out, then opens the sign-in page so another account can come back here. */
export const switchAccountWithoutApp = (): Promise<void> =>
  signOutWithoutApp(() => location.replace(webSignInHref()));
