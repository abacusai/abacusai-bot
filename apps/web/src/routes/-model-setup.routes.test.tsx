import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

let app: Awaited<ReturnType<typeof renderApp>> | undefined;
const width = window.innerWidth;
beforeEach(() =>
  Object.defineProperty(window, "innerWidth", {
    value: 1440,
    configurable: true,
  })
);
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
  });
});

it.each([
  "/sessions/new",
  "/sessions/spreadsheet?tab=files&view=split",
  "/bots/chief-of-staff",
])("%s keeps model setup in the picker", async (path) => {
  app = await renderApp(path);
  await waitFor(() =>
    expect(document.querySelector('[data-slot="composer"]')).not.toBeNull()
  );
  expect(
    screen.queryByRole("button", { name: "Configure a model" })
  ).toBeNull();
  if (path.startsWith("/bots"))
    fireEvent.focus(document.querySelector('[data-slot="composer"] textarea')!);
  const chip = await screen.findByRole("button", {
    name: "No model set. Choose a model",
  });
  fireEvent.click(chip);
  expect(
    await screen.findByRole("option", { name: /OpenRouter/ })
  ).toBeTruthy();
});
