import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSource, walk } from "./parsed-source.mjs";

export const visibleNotes = (files) =>
  files.flatMap((file) => {
    const rows = [];
    walk(parseSource(file).program, (node) => {
      if (node.type !== "ObjectExpression") return;
      const row = Object.fromEntries(
        node.properties
          .filter((p) => p.type === "Property" && p.value.type === "Literal")
          .map((p) => [p.key.name ?? p.key.value, p.value.value])
      );
      if (
        row.visible === true &&
        ["retired", "deferred"].includes(row.status)
      ) {
        if (!row.id || !row.reason)
          throw new Error(`Missing note metadata in ${file}`);
        rows.push(
          `- ${row.id}: ${row.reason}${row.status === "deferred" ? " Not in this version." : ""}`
        );
      }
    });
    return rows;
  });
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tree = fs.existsSync("apps/desktop/src/renderer/features")
    ? "renderer"
    : "renderer";
  const base = `apps/desktop/src/${tree}/features`;
  const files = fs
    .readdirSync(base)
    .map((area) => path.join(base, area, "parity.ts"))
    .filter((file) => fs.existsSync(file));
  const output =
    "# User-visible parity changes\n\n" + visibleNotes(files).join("\n") + "\n";
  fs.writeFileSync("docs/rewrite/reports/07-release-notes.md", output);
}
