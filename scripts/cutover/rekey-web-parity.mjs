import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../../apps/web/src/features");
for (const area of readdirSync(root)) {
  const file = resolve(root, area, "parity.ts");
  try {
    const source = readFileSync(file, "utf8");
    writeFileSync(
      file,
      source
        .replaceAll("src/renderer/", "apps/web/src/")
        .replaceAll('"src/main/', '"apps/desktop/src/main/')
        .replaceAll('"src/', '"apps/web/src/')
    );
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
}
