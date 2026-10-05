import fs from "node:fs";
import path from "node:path";

import {
  EXPERIENCE_PROTOCOL,
  FOUNDATION_API,
} from "@abacus-ai/contract/experience";
import { expect, it } from "vitest";
it("desktop and updater source compatibility constants move together", () => {
  const source = fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../../../../../updater/src/manifest.ts"
    ),
    "utf8"
  );
  expect(Number(source.match(/FOUNDATION_API\s*=\s*(\d+)/)?.[1])).toBe(
    FOUNDATION_API
  );
  expect(source.match(/PROTOCOL\s*=\s*"([^"]+)"/)?.[1]).toBe(
    EXPERIENCE_PROTOCOL
  );
});
