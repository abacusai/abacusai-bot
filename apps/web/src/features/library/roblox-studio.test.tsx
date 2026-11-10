/**
 * Roblox Studio on the Connectors page, in each state the host reports:
 * hidden where Studio cannot run, "Not installed" with the download as the
 * one action, the Studio switch kept in view once connected, and "Not
 * ready" with the fix and Try again when the agent cannot reach Studio.
 */
import { contract } from "@abacus-ai/contract/contract";
import type { ConnectorStatus } from "@abacus-ai/contract/contracts";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

import { offeredConnectors } from "./connector-status";
import { localAppHidden } from "./local-app";

const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});

const withRoblox = (status: ConnectorStatus, path: string, extra = {}) =>
  renderApp(path, {
    procedures: {
      connectors: {
        statuses: os.connectors.statuses.handler(() => ({
          "roblox-studio": status,
        })),
      },
      ...extra,
    },
  });

it("is not offered where Studio does not run, nor before the host has said", () => {
  const ids = (statuses: Record<string, ConnectorStatus> | undefined) =>
    offeredConnectors(statuses, true).map((entry) => entry.id);
  expect(
    ids({ "roblox-studio": { state: "unavailable", reason: "other-os" } })
  ).not.toContain("roblox-studio");
  expect(ids(undefined)).not.toContain("roblox-studio");
  expect(ids({ "roblox-studio": { state: "available" } })).toContain(
    "roblox-studio"
  );
  expect(
    localAppHidden(
      {
        kind: "mcp",
        id: "notion",
        name: "Notion",
        description: "x",
        category: "web",
        docsUrl: "https://x",
        auth: "oauth",
      },
      undefined
    )
  ).toBe(false);
});

it("is in Development, added in one click when Studio is installed", async () => {
  const connect = vi.fn(async () => ({ ok: true }) as const);
  app = await withRoblox(
    { state: "available" },
    "/library/connectors?category=development",
    {
      connectors: {
        statuses: os.connectors.statuses.handler(() => ({
          "roblox-studio": { state: "available" },
        })),
        connect: os.connectors.connect.handler(connect),
      },
    }
  );
  await screen.findByText("Roblox Studio");
  const row = document.querySelector(
    '[data-setting-id="roblox-studio"]'
  ) as HTMLElement;
  expect(within(row).getByText(/write and run scripts/)).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: "Add" }));
  await waitFor(() => expect(connect).toHaveBeenCalled());
  expect(connect.mock.calls[0]![0]).toMatchObject({
    input: { connectorId: "roblox-studio" },
  });
});

it("says Studio is not installed, and the dialog's one action is getting it", async () => {
  app = await withRoblox(
    { state: "available", reason: "app-missing" },
    "/library/connectors?category=development"
  );
  expect(await screen.findByText("Not installed")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  const dialog = await screen.findByTestId("connector-dialog");
  expect(within(dialog).getByRole("alert").textContent).toBe(
    "Roblox Studio isn't on this computer. Install it, then connect again."
  );
  expect(
    within(dialog).getByRole("button", { name: "Get Roblox Studio" })
  ).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: "Connect" })).toBeNull();
});

it("keeps the Studio switch in view once connected", async () => {
  app = await withRoblox(
    { state: "connected" },
    "/library/connectors?connector=roblox-studio"
  );
  const dialog = await screen.findByTestId("connector-dialog");
  expect(within(dialog).getByTestId("local-app-note").textContent).toContain(
    "Enable Studio as MCP server"
  );
  expect(within(dialog).getByText("Connected")).toBeTruthy();
});

it("says Studio is not ready, with the fix and Try again, when the agent cannot reach it", async () => {
  app = await withRoblox(
    { state: "pending", reason: "app-not-ready" },
    "/library/connectors?connector=roblox-studio"
  );
  const dialog = await screen.findByTestId("connector-dialog");
  await waitFor(() =>
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "Roblox Studio didn't answer."
    )
  );
  expect(within(dialog).getByText("Not ready")).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "Try again" })
  ).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "Disconnect" })
  ).toBeTruthy();
});
