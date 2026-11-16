import { installMainPreload } from "./main-preload";
import { installMotionEncoder } from "./motion-encoder";

// A motion render's hidden window gets the encoder and nothing else: no RPC
// port, no abacusHost (see motion-encoder.ts).
if (process.argv.includes("--abacus-window=motion")) installMotionEncoder();
else
  installMainPreload(
    process.argv.includes("--abacus-window=notch") ? "notch" : "main"
  );
