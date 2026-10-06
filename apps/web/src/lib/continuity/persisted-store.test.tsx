/**
 * `persistedStore`: what survives a reload when part of the stored record is
 * unusable, the composer's batching, and the lifecycle of a store that lives
 * with a component (the routine editor's log).
 */
import { act, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { EditorChat } from "#renderer/features/routines/page";
import { initI18n } from "#renderer/lib/i18n";

import { captureDrafts, persistedStore, restoreDrafts } from "./registry";

vi.mock("#renderer/lib/use-app-context", async (original) => ({
  ...(await original<typeof import("#renderer/lib/use-app-context")>()),
  useAppContext: () => ({ transport: { client: {} } }),
}));

const DRAFTS = "abacusai-bot:abacus.chat.drafts";
const TABS = "abacusai-bot:abacus.sessions.tabs";
const START = "abacusai-bot:abacus.sessions.start";
const LOG = "abacusai-bot:routine-editor:r1";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  sessionStorage.clear();
  vi.useRealTimers();
});
const make = <T,>(...args: Parameters<typeof persistedStore<T>>) => {
  const store = persistedStore<T>(...args);
  disposers.push(store.dispose);
  return store;
};

/** A pending send reload recovery resends: it must survive a bad sibling. */
const pending = {
  text: "ship it",
  attachments: [],
  mode: "PLAN",
  pendingSubmit: {
    runId: "run-1",
    messageId: "msg-1",
    parts: [{ type: "text", content: "ship it" }],
    forwardedProps: { model: "m" },
  },
  // A field this build's schema does not know yet is kept as stored.
  futureField: 1,
};

it("keeps every valid entry of a partly corrupt record, untouched in storage", () => {
  const stored = JSON.stringify({
    good: pending,
    bad: { text: 7, attachments: "nope" },
  });
  sessionStorage.setItem(DRAFTS, stored);
  const drafts = make<Record<string, unknown>>(DRAFTS, () => ({}));
  expect(drafts.state).toEqual({ good: pending });
  // Reading writes nothing back.
  expect(sessionStorage.getItem(DRAFTS)).toBe(stored);
  sessionStorage.setItem(
    TABS,
    JSON.stringify({
      a: { tabs: [], last: null },
      b: { tabs: [{ ref: 1 }], last: null },
    })
  );
  expect(make(TABS, () => ({})).state).toEqual({
    a: { tabs: [], last: null },
  });
});

it("falls back to the initial value without overwriting what is stored", () => {
  sessionStorage.setItem(START, JSON.stringify({ id: 3 }));
  const start = make<{ id: string }>(START, () => ({ id: "fresh" }));
  expect(start.state).toEqual({ id: "fresh" });
  expect(sessionStorage.getItem(START)).toBe(JSON.stringify({ id: 3 }));
  sessionStorage.setItem(LOG, '[{"user":"a","reply":"b"},{"user":1}]');
  expect(make(LOG, () => []).state).toEqual([{ user: "a", reply: "b" }]);
});

it("batches writes, sends an urgent change at once and flushes when the page hides", () => {
  vi.useFakeTimers();
  const drafts = make<
    Record<string, { text: string; pendingSubmit?: unknown }>
  >(DRAFTS, () => ({}), {
    batchMs: 250,
    urgent: (previous, next) =>
      Object.keys(next).some(
        (id) => previous[id]?.pendingSubmit !== next[id]?.pendingSubmit
      ),
  });
  drafts.setState(() => ({ t: { text: "h" } }));
  expect(sessionStorage.getItem(DRAFTS)).toBeNull();
  window.dispatchEvent(new Event("pagehide"));
  expect(JSON.parse(sessionStorage.getItem(DRAFTS)!)).toEqual({
    t: { text: "h" },
  });
  drafts.setState(() => ({
    t: { text: "h", pendingSubmit: pending.pendingSubmit },
  }));
  expect(JSON.parse(sessionStorage.getItem(DRAFTS)!).t.pendingSubmit).toEqual(
    pending.pendingSubmit
  );
});

it("binds a component's store only while it is mounted, StrictMode included", async () => {
  await initI18n();
  sessionStorage.setItem(LOG, JSON.stringify([{ user: "u0", reply: "r0" }]));
  const view = render(
    <StrictMode>
      <EditorChat routineId="r1" />
    </StrictMode>
  );
  expect(screen.getByText("r0", { selector: "p" })).not.toBeNull();
  // The mounted editor's store is the one a capture reads and a restore
  // writes.
  expect(captureDrafts()[LOG]?.value).toEqual([{ user: "u0", reply: "r0" }]);
  act(() =>
    restoreDrafts({
      [LOG]: {
        key: "routines.editorLog.v1",
        value: [{ user: "u1", reply: "r1" }],
      },
    })
  );
  expect(screen.getByText("r1", { selector: "p" })).not.toBeNull();
  view.unmount();
  // Unmounted: the restore reaches storage only, and a remount reads it.
  restoreDrafts({
    [LOG]: {
      key: "routines.editorLog.v1",
      value: [{ user: "u2", reply: "r2" }],
    },
  });
  expect(captureDrafts()[LOG]?.value).toEqual([{ user: "u2", reply: "r2" }]);
  render(<EditorChat routineId="r1" />);
  expect(screen.getByText("r2", { selector: "p" })).not.toBeNull();
});
