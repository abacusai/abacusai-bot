import fs from "node:fs";
import path from "node:path";

// The desktop and experience builds copy dist/ without the source manifest.
// Give Node an explicit module boundary beside main.js and its ESM chunks.
const dist = path.join(import.meta.dirname, "..", "dist");
if (!fs.existsSync(path.join(dist, "main.js"))) {
  throw new Error("Build the agent before writing its runtime package marker.");
}
fs.writeFileSync(path.join(dist, "package.json"), '{"type":"module"}\n');
