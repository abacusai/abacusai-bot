import { connectWebSocketTransport } from "#renderer/data/transport/websocket";
import { browserConnection } from "#renderer/features/shell/connect/services";
export const connectPlatformTransport = () => {
  const host = browserConnection();
  return connectWebSocketTransport(host.url, [
    "abacus-rpc",
    `abacus-token.${host.token}`,
  ]);
};
