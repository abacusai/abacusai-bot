import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, it } from "vitest";

// The policies themselves are pinned in apps/desktop/scripts/renderer-csp.test.ts.
it("serves the desktop favicon from a base-relative path", () => {
  const web = resolve(import.meta.dirname, "../../..");
  expect(readFileSync(resolve(web, "index.html"), "utf8")).toContain(
    'href="%BASE_URL%favicon.png"'
  );
  expect(readFileSync(resolve(web, "public/favicon.png"))).toEqual(
    readFileSync(resolve(web, "../desktop/build/icons/32x32.png"))
  );
});
