import { expect, it } from "vitest";

import { wireRefusal } from "./cli-wire.js";
it("absent wire selects AG-UI and ndjson returns the structured usage refusal", () => {
  expect(wireRefusal(undefined)).toBeNull();
  expect(wireRefusal("agui")).toBeNull();
  expect(wireRefusal("ndjson")).toEqual({
    type: "error",
    code: "wire_unsupported",
  });
  expect(wireRefusal("unknown")).toEqual({
    type: "error",
    code: "wire_unsupported",
  });
});
