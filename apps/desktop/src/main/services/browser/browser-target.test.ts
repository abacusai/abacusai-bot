/**
 * The tools must drive the calling session's own page, and keep driving it.
 */
import { describe, expect, it } from "vitest";

import { pickBrowserTarget, type BrowserViewCandidate } from "./browser-target";

const view = (
  id: number,
  sessionId: string | null,
  extra: Partial<BrowserViewCandidate> = {}
): BrowserViewCandidate => ({
  id,
  url: "",
  sessionId,
  presented: false,
  ...extra,
});

const fresh = { id: null, url: null };

describe("picking the view to drive", () => {
  it("never picks another session's view", () => {
    const views = [view(1, "other", { presented: true }), view(2, "other")];

    expect(pickBrowserTarget(views, fresh, "mine")).toBeNull();
  });

  it("prefers the session's view that is on screen", () => {
    const views = [view(1, "mine"), view(2, "mine", { presented: true })];

    expect(pickBrowserTarget(views, fresh, "mine")).toBe(2);
  });

  it("stays on the view already being driven", () => {
    const views = [view(1, "mine", { presented: true }), view(2, "mine")];

    expect(pickBrowserTarget(views, { id: 2, url: null }, "mine")).toBe(2);
  });

  it("finds the view again by URL when it remounts with a new id", () => {
    const views = [view(7, "mine"), view(8, "mine", { url: "https://a.test" })];

    expect(
      pickBrowserTarget(views, { id: 3, url: "https://a.test" }, "mine")
    ).toBe(8);
  });

  it("takes the presented view when the caller has no session", () => {
    const views = [view(1, "a"), view(2, "b", { presented: true })];

    expect(pickBrowserTarget(views, fresh)).toBe(2);
    expect(pickBrowserTarget(views, fresh, null)).toBe(2);
  });

  it("falls back to the session's first view", () => {
    const views = [view(4, "other"), view(5, "mine"), view(6, "mine")];

    expect(pickBrowserTarget(views, fresh, "mine")).toBe(5);
  });

  it("reports no view rather than inventing one", () => {
    expect(pickBrowserTarget([], fresh, "mine")).toBeNull();
    expect(pickBrowserTarget([], fresh)).toBeNull();
  });
});
