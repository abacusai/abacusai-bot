/**
 * Compatibility gate between the foundation (the installed Electron shell and
 * native pieces) and the experience (the renderer and agent bundles, shipped
 * as a TUF archive without a relaunch). `PROTOCOL` names the wire/IPC/resource
 * contract, `FOUNDATION_API` the shell capability revision; the updater
 * refuses an experience built for a different value of either. Must stay in
 * step with `apps/updater/src/manifest.ts`.
 */
export const EXPERIENCE_PROTOCOL = "abacus.desktop/1";

export const FOUNDATION_API = 1;
