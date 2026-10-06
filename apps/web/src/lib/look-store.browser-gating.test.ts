/** The browser keeps the boot look per user, in the last-known store. */
import { afterEach, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "a" as string | null }));
vi.mock("#renderer/features/shell/connect/services", () => ({
  hostIdentity: () =>
    identity.id == null ? undefined : { deploymentConversationId: identity.id },
}));

import { lookStore } from "#platform/last-known";

import { DEFAULT_LOOK, resolveLook } from "./look";
import { applyBootLook, applyLook, setLookStore } from "./theme";

const media = { dark: false, high: false };
const root = () => document.documentElement;
afterEach(() => {
  setLookStore(null);
  localStorage.clear();
  root().removeAttribute("style");
});

it("remembers each user's look under their host and paints only theirs", () => {
  setLookStore(lookStore);
  const source = {
    theme: "light" as const,
    appearance: { ...DEFAULT_LOOK, palette: "grove" },
  };
  applyLook(
    document,
    resolveLook(source.appearance, "light", false),
    true,
    source
  );
  expect(localStorage.getItem("abacusai-bot:last-known:look:a")).not.toBeNull();
  expect(localStorage.getItem("abacus.look")).toBeNull();
  root().removeAttribute("style");

  identity.id = "b";
  applyBootLook(document, media);
  expect(root().style.getPropertyValue("--background")).toBe("");

  identity.id = "a";
  expect(applyBootLook(document, media)).toBe("light");
  expect(root().style.getPropertyValue("--background")).toBe("#f6faf6");

  // Before the host is identified nothing is read.
  identity.id = null;
  root().removeAttribute("style");
  applyBootLook(document, media);
  expect(root().style.getPropertyValue("--background")).toBe("");
});
