import path from "node:path";
import { fileURLToPath } from "node:url";

/** Filesystem layout shared by the publisher and read-only server. */
export interface UpdaterPaths {
  readonly bootstrapRoot: string;
  readonly keys: string;
  readonly metadata: string;
  readonly root: string;
  readonly targets: string;
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export const updaterPaths = (configured?: string): UpdaterPaths => {
  const root =
    configured ??
    process.env["ABACUSAI_BOT_UPDATE_DATA"] ??
    path.join(packageRoot, ".data", "updater");
  return {
    bootstrapRoot: path.join(root, "bootstrap-root.json"),
    keys: path.join(root, "keys"),
    metadata: path.join(root, "repository", "metadata"),
    root,
    targets: path.join(root, "repository", "targets"),
  };
};
