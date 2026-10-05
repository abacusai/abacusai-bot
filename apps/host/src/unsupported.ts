/** Thrown by the Electron shim when host code reaches an Electron-only member. */
export class HostUnsupportedError extends Error {
  constructor(member: string) {
    super(`Electron member ${member} is unavailable on the web host`);
    this.name = "HostUnsupportedError";
  }
}
