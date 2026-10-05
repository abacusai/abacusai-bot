import { browserConnection, callApps, ConnectError } from "./connect/services";
let lastActivity = -Infinity;
export const markActivity = () => {
  lastActivity = Date.now();
};
export const installLease = (connected: () => boolean): (() => void) => {
  const timer = setInterval(() => {
    if (
      connected() &&
      document.visibilityState === "visible" &&
      Date.now() - lastActivity < 5 * 60_000
    )
      void callApps("keepAliveAbacusBotHost", {
        deploymentConversationId: browserConnection().deploymentConversationId,
      }).catch((error) => {
        // Out of today's time: the connect screen explains and links the
        // download (the server also stops the host).
        if (error instanceof ConnectError && error.kind === "limit")
          window.location.reload();
        else console.warn("[lease]", error);
      });
  }, 60_000);
  return () => clearInterval(timer);
};
