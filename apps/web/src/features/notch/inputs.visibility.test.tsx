import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { DEFAULT_PREFS } from "#renderer/data/db/prefs";
import type { Transport } from "#renderer/data/transport";

import { useNotchInputs } from "./inputs";
const f = vi.hoisted(() => ({ receive: null as any }));
vi.mock("#renderer/data/db", () => ({
  useDb: () => ({ collections: { sessions: {}, bots: {}, routines: {} } }),
}));
vi.mock("#renderer/data/db/prefs", async (original) => ({
  ...(await original<typeof import("#renderer/data/db/prefs")>()),
  usePrefs: () => DEFAULT_PREFS,
}));
vi.mock("@tanstack/react-db", () => ({ useLiveQuery: () => ({ data: [] }) }));
vi.mock("#renderer/lib/run-finished", () => ({
  runFinishedFeed: () => ({ subscribe: () => () => {} }),
}));
vi.mock("#renderer/data/queries/live", () => ({
  followNotices: async (
    _t: unknown,
    subscribe: any,
    receive: any,
    signal: AbortSignal
  ) => {
    if (subscribe({ signal }) === "notch") f.receive = receive;
  },
}));
it("Space requests resample unchanged document visibility and carry the epoch on later reports", async () => {
  const visibility = vi.fn(async () => {});
  const transport = {
    client: {
      ai: { attention: () => "attention" },
      connectors: { events: () => "connectors" },
      notch: { events: () => "notch", visibility },
    },
  } as unknown as Transport;
  const view = renderHook(() =>
    useNotchInputs(
      transport,
      { mainFocused: false },
      false,
      new Set(),
      new Map()
    )
  );
  expect(visibility).toHaveBeenLastCalledWith({
    documentVisible: true,
    epoch: 0,
  });
  await act(async () => f.receive({ type: "visibility-request", epoch: 3 }));
  expect(visibility).toHaveBeenLastCalledWith({
    documentVisible: true,
    epoch: 3,
  });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(visibility).toHaveBeenLastCalledWith({
    documentVisible: true,
    epoch: 3,
  });
  view.unmount();
});
