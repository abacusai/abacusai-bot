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
  await applyTerminalOutput(view, {
    type: "snapshot",
    from: 3,
    offset: 6,
    data: "new",
  });
  expect(content).toBe("oldnew");
  await applyTerminalOutput(view, {
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

it("advances the cursor only after an asynchronous replay completes", async () => {
  let release!: () => void;
  const written: string[] = [];
  const view = {
    offset: 3 as number | undefined,
    write: async (data: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      written.push(data);
    },
    reset: () => {},
  };
  const applying = applyTerminalOutput(view, {
    type: "data",
    data: "tail",
    offset: 7,
  });
  expect(view.offset).toBe(3);
  expect(written).toEqual([]);
  release();
  await applying;
  expect(view.offset).toBe(7);
  expect(written).toEqual(["tail"]);
});
