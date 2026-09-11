import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BrowserRuntimeRegistry,
  BrowserScopePromotionError,
  StaleBrowserRuntimeError,
  browserResourceId,
  conversationKey,
  type BrowserNativeViewFactory,
  type BrowserNativeViewHost,
  type BrowserRuntimeLease,
  type NativeBrowserView,
} from "./browser-runtime-registry";

type TestView = NativeBrowserView & {
  id: string;
};

const draft = conversationKey({
  workspaceId: "workspace-one",
  sessionId: null,
});
const session = conversationKey({
  workspaceId: "workspace-one",
  sessionId: "session-one",
});
const secondSession = conversationKey({
  workspaceId: "workspace-one",
  sessionId: "session-two",
});
const otherSession = conversationKey({
  workspaceId: "workspace-two",
  sessionId: "session-two",
});
const browserOne = browserResourceId("browser-one");
const browserTwo = browserResourceId("browser-two");

describe("browser runtime registry", () => {
  let events: string[];
  let factory: BrowserNativeViewFactory<TestView>;
  let host: BrowserNativeViewHost<TestView>;
  let registry: BrowserRuntimeRegistry<TestView>;

  beforeEach(() => {
    events = [];
    factory = {
      create: vi.fn((lease: BrowserRuntimeLease): TestView => {
        const id = `${lease.resourceId}@${lease.generation}`;
        events.push(`create:${id}`);
        return {
          id,
          webContents: {
            close: vi.fn(() => events.push(`close:${id}`)),
          },
        };
      }),
    };
    host = {
      present: vi.fn((view) => events.push(`present:${view.id}`)),
      hide: vi.fn((view) => events.push(`hide:${view.id}`)),
      detach: vi.fn((view) => events.push(`detach:${view.id}`)),
    };
    registry = new BrowserRuntimeRegistry(factory, host);
  });

  it("materializes once and presents or hides idempotently", () => {
    const lease = registry.materialize(draft, browserOne);

    expect(registry.materialize(draft, browserOne)).toEqual(lease);
    expect(factory.create).toHaveBeenCalledOnce();
    expect(registry.snapshot(lease).presentation).toBe("hidden");

    registry.present(lease);
    registry.present(lease);
    expect(host.present).toHaveBeenCalledOnce();
    expect(registry.snapshot(lease).presentation).toBe("presented");

    registry.hide(lease);
    registry.hide(lease);
    expect(host.hide).toHaveBeenCalledOnce();
    expect(registry.snapshot(lease).presentation).toBe("hidden");
  });

  it("always hides, detaches, and closes owned webContents on close", () => {
    const lease = registry.materialize(session, browserOne);
    registry.present(lease);
    events.length = 0;

    registry.close(lease);

    expect(events).toEqual([
      `hide:${browserOne}@${lease.generation}`,
      `detach:${browserOne}@${lease.generation}`,
      `close:${browserOne}@${lease.generation}`,
    ]);
    expect(() => registry.snapshot(lease)).toThrow(StaleBrowserRuntimeError);
  });

  it("rejects stale operations after rematerialization", () => {
    const first = registry.materialize(session, browserOne);
    registry.close(first);
    const second = registry.materialize(session, browserOne);

    expect(second.generation).toBeGreaterThan(first.generation);
    expect(() => registry.present(first)).toThrow(StaleBrowserRuntimeError);
    expect(() => registry.hide(first)).toThrow(StaleBrowserRuntimeError);
    expect(() => registry.close(first)).toThrow(StaleBrowserRuntimeError);
    expect(registry.snapshot(second).presentation).toBe("hidden");
  });

  it("promotes draft runtimes once without recreating their native views", () => {
    const firstDraftLease = registry.materialize(draft, browserOne);
    const secondDraftLease = registry.materialize(draft, browserTwo);

    const promoted = registry.promoteDraftScope(draft, session);
    const repeated = registry.promoteDraftScope(draft, session);

    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(promoted).toHaveLength(2);
    expect(repeated).toEqual(promoted);
    expect(promoted.map(({ conversationKey: key }) => key)).toEqual([
      session,
      session,
    ]);
    expect(promoted[0]!.generation).toBeGreaterThan(firstDraftLease.generation);
    expect(promoted[1]!.generation).toBeGreaterThan(
      secondDraftLease.generation
    );
    expect(() => registry.present(firstDraftLease)).toThrow(
      StaleBrowserRuntimeError
    );

    registry.present(promoted[0]!);
    expect(host.present).toHaveBeenCalledOnce();
  });

  it("rejects cross-workspace and non-draft promotion", () => {
    expect(() => registry.promoteDraftScope(draft, otherSession)).toThrow(
      BrowserScopePromotionError
    );
    expect(() => registry.promoteDraftScope(session, secondSession)).toThrow(
      BrowserScopePromotionError
    );
  });

  it("leaves both scopes intact when promotion would collide", () => {
    const draftLease = registry.materialize(draft, browserOne);
    const sessionLease = registry.materialize(session, browserOne);

    expect(() => registry.promoteDraftScope(draft, session)).toThrow(
      BrowserScopePromotionError
    );
    expect(registry.snapshot(draftLease).conversationKey).toBe(draft);
    expect(registry.snapshot(sessionLease).conversationKey).toBe(session);
    expect(factory.create).toHaveBeenCalledTimes(2);
  });

  it("disposes one scope, one workspace, or the full registry without global scans", () => {
    const draftOne = registry.materialize(draft, browserOne);
    const sessionTwo = registry.materialize(session, browserTwo);
    const other = registry.materialize(otherSession, browserOne);

    registry.disposeScope(draft);
    expect(() => registry.snapshot(draftOne)).toThrow(StaleBrowserRuntimeError);
    expect(registry.snapshot(sessionTwo).resourceId).toBe(browserTwo);
    expect(registry.snapshot(other).resourceId).toBe(browserOne);

    registry.disposeWorkspace("workspace-one");
    expect(() => registry.snapshot(sessionTwo)).toThrow(
      StaleBrowserRuntimeError
    );
    expect(registry.snapshot(other).resourceId).toBe(browserOne);

    registry.disposeAll();
    expect(() => registry.snapshot(other)).toThrow(StaleBrowserRuntimeError);
    expect(host.detach).toHaveBeenCalledTimes(3);
  });

  it("attempts detach and webContents.close even when hiding throws", () => {
    const lease = registry.materialize(session, browserOne);
    const failure = new Error("hide failed");
    vi.mocked(host.hide).mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => registry.close(lease)).toThrow(AggregateError);
    expect(host.detach).toHaveBeenCalledOnce();
    expect(events).toContain(`close:${browserOne}@${lease.generation}`);
    expect(() => registry.snapshot(lease)).toThrow(StaleBrowserRuntimeError);
  });
});
