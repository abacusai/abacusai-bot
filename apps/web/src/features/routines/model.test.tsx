import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import type { ModelAvailability } from "@abacus-ai/contract/models";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";

import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";

const models: ModelAvailability[] = [
  {
    id: "a/router",
    label: "Router",
    provider: "a",
    tier: "default",
    configured: true,
    recommended: true,
  },
  {
    id: "a/pricey",
    label: "Pricey",
    provider: "a",
    tier: "strong",
    configured: true,
  },
];

const openRoutine = (patch: Partial<RoutineRow>) => {
  const seed = defaultSeed();
  const [first, ...rest] = seed.routines!;
  return renderApp("/routines/morning-digest", {
    models,
    seed: { ...seed, routines: [{ ...first!, ...patch }, ...rest] },
  });
};

it("shows a routine's model, and the picker changes that routine alone", async () => {
  const app = await openRoutine({ model: "a/router" });
  try {
    const section = await screen.findByRole("region", { name: "Model" });
    fireEvent.click(
      await within(section).findByRole("button", { name: "Router" })
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Pricey/ }));
    await waitFor(() =>
      expect(app.collections.routines.get("morning-digest")?.model).toBe(
        "a/pricey"
      )
    );
    expect(app.calls).not.toContainEqual(
      expect.arrayContaining(["settings.setDefaultModel"])
    );
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it.each([
  ["a costly model", "a/pricey", "Every run uses Pricey", true],
  ["the plan's router", "a/router", "Every run uses", false],
])("says so when a routine is on %s", async (_, model, line, shown) => {
  const app = await openRoutine({ model });
  try {
    await screen.findByRole("region", { name: "Model" });
    await waitFor(() =>
      expect(
        screen
          .getByRole("region", { name: "Model" })
          .textContent?.includes(line)
      ).toBe(shown)
    );
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("names what the plan's default runs on", async () => {
  const app = await openRoutine({ model: null });
  try {
    expect(
      await screen.findByText("Follows your plan's default: Router.")
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Plan default" })).not.toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("a hosted routine names its model and offers no picker", async () => {
  const app = await openRoutine({
    id: "hosted-routine",
    runner: "hosted",
    hosted: {
      kind: "task",
      timezone: null,
      notify: "always",
      delivery: "default",
      sources: [],
      reads: [],
      watchUrl: null,
      pausedReason: null,
      lastRun: null,
    },
  });
  try {
    await app.router.navigate({ href: "/routines/hosted-routine" });
    const section = await screen.findByRole("region", { name: "Model" });
    expect(
      await within(section).findByText(
        "Hosted routines run on your plan's default."
      )
    ).not.toBeNull();
    expect(within(section).queryByRole("button")).toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
