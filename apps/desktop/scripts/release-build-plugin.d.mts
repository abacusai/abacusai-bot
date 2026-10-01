import type { Plugin } from "vite";
export function releaseBuildPlugin(
  root: string,
  release: boolean,
  flags: { gallery: boolean; fixtures: boolean }
): Plugin;
