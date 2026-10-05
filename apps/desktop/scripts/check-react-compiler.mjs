#!/usr/bin/env node
/** Run the shipping build, treating every React Compiler diagnostic as a failure. */
import { fileURLToPath } from "node:url";

import { createBuilder } from "vite";

let diagnostics = 0;
const builder = await createBuilder({
  root: fileURLToPath(new URL("../../web", import.meta.url)),
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  build: {
    rolldownOptions: {
      onLog(level, log, handler) {
        // Use structured plugin identity, not text: Rolldown timing reports
        // also mention this plugin and are not compiler diagnostics.
        if (log.plugin === "vite:react-compiler") diagnostics++;
        handler(level, log);
      },
    },
  },
});
await builder.buildApp();
if (diagnostics > 0) {
  console.error(`check:react-compiler: ${diagnostics} compiler diagnostics`);
  process.exitCode = 1;
} else {
  console.log("check:react-compiler: zero compiler diagnostics");
}
