import { pageTransport } from "#renderer/features/shell/connect/services";
/** The page's host transport, created once the user's host is known. */
export const connectPlatformTransport = async () => pageTransport();
