import { updaterPaths } from "./paths.ts";
import { initializeDevRepository } from "./repository.ts";
import { serve } from "./server.ts";

/** Local repository bootstrap and server. */
const paths = updaterPaths();
await initializeDevRepository(paths);
serve(paths);
