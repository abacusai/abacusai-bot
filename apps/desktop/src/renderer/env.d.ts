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

  /** The preload's only other export besides the port (spec 00 A.4.4). */
  interface Window {
    abacusHost?: { getPathForFile(file: File): string };
  }

  interface ImportMetaEnv {
    /** "1" in the screenshot build: `/__ui` and `__abacusDev` exist. */
    readonly VITE_UI_GALLERY?: string;
    /**
     * "1": the DB tables come from in-renderer fixtures instead of main,
     * while main's `db.*` answers UNAVAILABLE (spec 00 sub-slice B pending).
     */
    readonly VITE_NEXT_DB_FIXTURES?: string;
  }
}

export {};
