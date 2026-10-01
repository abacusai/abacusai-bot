import { installMainPreload } from "./main-preload";

installMainPreload(
  process.argv.includes("--abacus-window=notch") ? "notch" : "main"
);
