import { browserConnection, callApps } from "./connect/services";
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
      }).catch((error) => console.warn("[lease]", error));
  }, 60_000);
  return () => clearInterval(timer);
};
