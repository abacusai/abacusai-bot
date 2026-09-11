/**
 * Types for vendor-fetch.js, which is plain JavaScript because it runs from
 * build scripts before anything is compiled. Declared here so a TypeScript
 * consumer — the test that pins the retry rules — sees real signatures rather
 * than `any`.
 */
export declare function digest(buf: Buffer | Uint8Array): string;

export declare function fetchVerified(
  url: string,
  sha256: string,
  label: string
): Promise<Buffer>;

export declare function writeVendored(
  dest: string,
  body: Buffer | Uint8Array,
  mode?: number
): void;

export declare function isCurrent(dest: string, sha256: string): boolean;

export declare function run(label: string, main: () => Promise<void>): void;
