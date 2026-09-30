import { expect, it } from "vitest";

import { applyTerminalOutput, pumpOutput } from "./output-pump";
it("R4-T17 appends offset snapshots and replaces an unavailable retained position", async () => {
  let content = "old";
  const view = {
    offset: 3 as number | undefined,
    write: (s: string) => {
      content += s;
    },
    reset: () => {
      content = "";
    },
  };
  applyTerminalOutput(view, {
    type: "snapshot",
    from: 3,
    offset: 6,
    data: "new",
  });
  expect(content).toBe("oldnew");
  applyTerminalOutput(view, {
    type: "snapshot",
    from: 8,
    offset: 12,
    data: "tail",
  });
  expect(content).toBe("tail");
  const offsets: unknown[] = [];
  let tries = 0;
  await pumpOutput(
    view,
    async (offset) => {
      offsets.push(offset);
      return (async function* () {
        if (tries++ === 0) {
          yield { type: "data" as const, data: "!", offset: 13 };
          throw Error("RESYNC_REQUIRED");
        }
        yield { type: "snapshot" as const, from: 13, offset: 14, data: "?" };
        yield { type: "retired" as const, reason: "closed" as const };
      })();
    },
    new AbortController().signal,
    () => {},
    () => {}
  );
  expect(offsets).toEqual([12, 13]);
  expect(content).toBe("tail!?");
});
