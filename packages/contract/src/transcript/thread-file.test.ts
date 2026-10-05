/** Twin classification (spec 00 C.3): what may never be replaced. */
import { describe, expect, it } from "vitest";

import { parseThreadTwin } from "./thread-file";

const status = (value: unknown) =>
  parseThreadTwin(JSON.stringify(value)).status;

describe("parseThreadTwin", () => {
  it("classifies an unknown source kind as foreign before checking messages (r2 #6)", () => {
    expect(
      status({ version: 2, source: { kind: "future" }, messages: { a: 1 } })
    ).toBe("foreign");
    expect(status({ version: 2, source: { kind: "future" } })).toBe("foreign");
  });

  it("classifies a newer version as foreign whatever its source says (r2 #4)", () => {
    expect(
      status({
        version: 3,
        source: { kind: "transcript-v1", updatedAt: "x", segments: 1 },
        messages: [],
      })
    ).toBe("foreign");
  });

  it("keeps garbage corrupt", () => {
    expect(parseThreadTwin("{half").status).toBe("corrupt");
    expect(status([1])).toBe("corrupt");
    expect(status({ version: 2, source: { kind: "agui" } })).toBe("corrupt");
  });
});
