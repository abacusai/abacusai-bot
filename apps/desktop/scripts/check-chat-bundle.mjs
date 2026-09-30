#!/usr/bin/env node
import { dirname, resolve } from "node:path";
/** A production build must contain no chat fixture or gallery modules. */
import { fileURLToPath } from "node:url";

import { build } from "vite";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.VITE_UI_GALLERY = "";
process.env.VITE_NEXT_DB_FIXTURES = "";
let chunks = 0;
await build({
  root: desktop,
  plugins: [
    {
      name: "check-chat-bundle",
      generateBundle(_options, bundle) {
        const forbidden = new Set();
        for (const item of Object.values(bundle)) {
          if (item.type !== "chunk") continue;
          chunks += 1;
          for (const id of Object.keys(item.modules))
            if (/renderer-next\/features\/chat\/(fixtures|gallery)\//.test(id))
              forbidden.add(id);
        }
        if (forbidden.size > 0)
          throw new Error(
            `Chat dev modules in production:\n${[...forbidden].join("\n")}`
          );
      },
    },
  ],
});
console.info(`Chat bundle check passed across ${chunks} chunks.`);
