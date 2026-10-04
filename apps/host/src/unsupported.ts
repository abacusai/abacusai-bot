import { ORPCError } from "@orpc/server";
export const unsupported = (procedure = "host") => {
  throw new ORPCError("UNSUPPORTED", {
    status: 501,
    message: "not available on the web host",
    data: { procedure },
  });
};
export class HostUnsupportedError extends Error {
  constructor(member: string) {
    super(`Electron member ${member} is unavailable on the web host`);
    this.name = "HostUnsupportedError";
  }
}
