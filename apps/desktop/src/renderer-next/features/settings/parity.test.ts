import { describe, expect, it } from "vitest";

import { PHASE5_PARITY as artifacts } from "../artifacts/parity";
import { PHASE5_PARITY as library } from "../library/parity";
import { PHASE5_PARITY as routines } from "../routines/parity";
import { PHASE5_PARITY as settings } from "./parity";

const sources = import.meta.glob("../*/index.{ts,tsx}", {
  query: "?raw",
  import: "default",
});

describe("R5-T38 phase-5 inventory", () => {
  it.each([...routines, ...artifacts, ...library, ...settings])(
    "$id names an existing consumer and a status",
    (row) => {
      expect(
        Object.keys(sources).some(
          (path) =>
            (path === "./index.tsx"
              ? "features/settings/index.tsx"
              : `features/${path.replace(/^\.\.\//, "")}`) === row.target
        )
      ).toBe(true);
      expect(["implemented", "partial", "retired"]).toContain(row.status);
    }
  );
});
