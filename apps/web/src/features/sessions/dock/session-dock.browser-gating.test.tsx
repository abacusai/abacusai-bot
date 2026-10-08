import { act, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";
it("expands a deep-linked Files pane on phones and keeps its selection when resized", async () => {
  const width = window.innerWidth;
  Object.defineProperty(window, "innerWidth", {
    value: 390,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));
  const app = await renderApp(
    "/sessions/spreadsheet?tab=files&file=README.md&view=split"
  );
  const dock = () => document.querySelector('[data-slot="session-dock"]');
  try {
    await waitFor(() => expect(dock()?.getAttribute("data-view")).toBe("full"));
    expect(app.router.state.location.search.file).toBe("README.md");
    await act(async () => {
      Object.defineProperty(window, "innerWidth", {
        value: 1440,
        configurable: true,
      });
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() =>
      expect(dock()?.getAttribute("data-view")).toBe("split")
    );
    expect(app.router.state.location.search.file).toBe("README.md");
  } finally {
    app.view.unmount();
    await app.cleanup();
    Object.defineProperty(window, "innerWidth", {
      value: width,
      configurable: true,
    });
    window.dispatchEvent(new Event("resize"));
  }
});
