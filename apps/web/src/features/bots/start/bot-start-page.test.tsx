/**
 * The start gallery ranks templates by connected connectors without
 * moving cards that are already on screen.
 */
import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { act, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

let harness: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  harness?.view.unmount();
  await harness?.cleanup();
  harness = undefined;
});

it("/bots/new keeps its template order when connector statuses arrive late, and ranks them on the next visit", async () => {
  const os = implement(contract);
  let release!: (statuses: unknown) => void;
  const statuses = new Promise((resolve) => {
    release = resolve;
  });
  harness = await renderApp("/bots/new", {
    procedures: {
      connectors: {
        statuses: os.connectors.statuses.handler(() => statuses as never),
      },
    },
  });
  const order = () =>
    [
      ...harness!.view.container.querySelectorAll('[data-slot="bot-template"]'),
    ].map((card) => card.getAttribute("aria-describedby"));
  await waitFor(() => expect(order().length).toBeGreaterThan(1));
  const before = order();
  expect(before[0]).not.toBe("template-email-drafting");
  expect(before).toContain("template-email-drafting");
  const { queryClient, transport } = harness.router.options.context;
  await act(async () => {
    release({ "abacus-gmailuser": { state: "connected" } });
    await statuses;
  });
  await waitFor(() =>
    expect(
      queryClient.getQueryData(
        transport.orpc.connectors.statuses.queryKey({ input: {} })
      )
    ).toBeDefined()
  );
  expect(order()).toEqual(before);
  await act(() => harness!.router.navigate({ to: "/routines" }));
  await act(() => harness!.router.navigate({ to: "/bots/new" }));
  await waitFor(() => expect(order()[0]).toBe("template-email-drafting"));
});
