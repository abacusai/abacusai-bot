import { fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import enUS from "#locales/en-US.json";
import { renderWithDb } from "#renderer/features/chat/testing";
import { DESKTOP_DOWNLOAD_URL } from "#renderer/lib/abacus-links";
import { useHasContextualUpsell } from "#renderer/lib/contextual-upsell";

import { BrowserSkillImport } from "./skills-tools";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
const Suppression = () => (
  <output data-testid="suppression">{String(useHasContextualUpsell())}</output>
);
it.each(["folder", "file"] as const)(
  "offers a desktop download after browser %s import intent and releases suppression when closed",
  async (kind) => {
    const rendered = await renderWithDb(
      <>
        <BrowserSkillImport />
        <Suppression />
      </>
    );
    cleanup = rendered.cleanup;
    expect(
      screen.queryByText(enUS.web.files.skillImportUnavailable)
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: enUS.phase5.skillImport[kind] })
    );
    expect(
      await screen.findByText(enUS.web.files.skillImportUnavailable)
    ).not.toBeNull();
    expect(
      screen.getByRole("dialog", { name: enUS.phase5.skillImport[kind] })
    ).not.toBeNull();
    expect(
      screen
        .getByRole("button", { name: enUS.web.files.download })
        .getAttribute("href")
    ).toBe(DESKTOP_DOWNLOAD_URL);
    expect(screen.getByTestId("suppression").textContent).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("suppression").textContent).toBe("false");
  }
);
