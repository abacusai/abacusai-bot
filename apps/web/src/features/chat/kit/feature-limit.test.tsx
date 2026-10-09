import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { inertHostActions } from "../runtime/host-actions";
import { renderWithDb } from "../testing";
import { FeatureLimitNotice } from "./parts";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
it.each([
  ["free", false, "Upgrade"],
  ["basic", true, "Upgrade"],
  ["paid", true, "Manage plan"],
  ["paid", false, null],
  ["basic", false, null],
  ["unknown", false, null],
] as const)(
  "feature limit uses eligible %s account action (%s)",
  async (tier, eligible, label) => {
    const openUpgrade = vi.fn(async () => {});
    const openExternal = vi.fn(async () => {});
    const accountTier = vi.fn(async () => tier);
    const rendered = await renderWithDb(
      <FeatureLimitNotice
        feature="Search"
        host={{
          ...inertHostActions,
          accountTier,
          canTopUpCredits: async () => eligible,
          openUpgrade,
          openExternal,
        }}
      />
    );
    cleanup = rendered.cleanup;
    if (label) {
      fireEvent.click(await screen.findByRole("button", { name: label }));
      expect(openUpgrade).toHaveBeenCalledOnce();
      expect(openExternal).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(accountTier).toHaveBeenCalled());
      expect(screen.queryByRole("button")).toBeNull();
    }
  }
);
