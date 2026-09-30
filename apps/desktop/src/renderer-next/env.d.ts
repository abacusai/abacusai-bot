/**
 * The one Node type the shared modules name (`NodeJS.Platform`, in
 * shared/terminal-shells.ts), declared here so this project compiles without
 * Node's or Electron's types: the new renderer must not reach either.
 */
declare global {
  namespace NodeJS {
    type Platform =
      | "aix"
      | "android"
      | "darwin"
      | "freebsd"
      | "haiku"
      | "linux"
      | "openbsd"
      | "sunos"
      | "win32"
      | "cygwin"
      | "netbsd";
  }
}

export {};
