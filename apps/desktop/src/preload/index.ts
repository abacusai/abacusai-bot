import { installArtifactAppPreload } from "./artifact-app";
import { installMainPreload } from "./main-preload";

// An installed artifact app's window gets only its store (artifact-app.ts).
if (process.argv.includes("--abacus-window=artifact-app"))
  installArtifactAppPreload();
else
  installMainPreload(
    process.argv.includes("--abacus-window=notch") ? "notch" : "main"
  );
