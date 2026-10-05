import { contract } from "@abacus-ai/contract/contract";
import type { McpServerInfo } from "@abacus-ai/contract/contracts";
import { implement } from "@orpc/server";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";
const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});
it("R5-T16 deferred queue survives a fresh app and dismiss writes only that preference", async () => {
  const seed = defaultSeed();
  seed.prefs!.onboardingPairing = ["whatsapp"];
  app = await renderApp("/library/connectors", { seed });
  expect(
    (await screen.findByRole("button", { name: "Link WhatsApp" })).getAttribute(
      "href"
    )
  ).toMatch(/^\/library\/messaging/);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() =>
    expect(app!.collections.prefs.get("app")?.onboardingPairing).toEqual([])
  );
});
it("R5-T20 MCP form refreshes untouched fields twice and retains the edited command in the outgoing write", async () => {
  let server: McpServerInfo = {
    id: "example",
    name: "example",
    isBuiltin: false,
    config: { command: "initial", args: ["one"] },
  };
  const update = vi.fn(async (_context: unknown) => ({ success: true }));
  app = await renderApp("/library/mcp?server=example", {
    procedures: {
      mcp: {
        list: os.mcp.list.handler(() => [server]),
        update: os.mcp.update.handler(update),
      },
    },
  });
  const command = await screen.findByRole("textbox", { name: "Command" });
  const args = screen.getByRole("textbox", {
    name: "Arguments (one per line)",
  });
  fireEvent.change(command, { target: { value: " my-command " } });
  for (const arg of ["two", "three"]) {
    server = { ...server, config: { command: "remote", args: [arg] } };
    await act(async () => {
      await app!.router.options.context.queryClient.invalidateQueries({
        queryKey: app!.transport.orpc.mcp.list.queryKey({
          input: { mode: "code" },
        }),
      });
    });
    await waitFor(() => expect((args as HTMLTextAreaElement).value).toBe(arg));
    expect((command as HTMLInputElement).value).toBe(" my-command ");
  }
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(update).toHaveBeenCalled());
  expect(update.mock.calls[0]![0]).toMatchObject({
    input: {
      name: "example",
      config: { command: "my-command", args: ["three"] },
    },
  });
});
it("R5-T20 MCP transport shows only its fields and rejects a non-HTTP URL", async () => {
  const add = vi.fn(async () => ({ success: true }));
  app = await renderApp("/library/mcp?server=new", {
    procedures: {
      mcp: {
        list: os.mcp.list.handler(() => []),
        add: os.mcp.add.handler(add),
      },
    },
  });
  expect(await screen.findByLabelText("Command")).not.toBeNull();
  expect(screen.queryByLabelText("URL")).toBeNull();
  fireEvent.change(screen.getByLabelText("Transport"), {
    target: { value: "http" },
  });
  fireEvent.change(await screen.findByLabelText("URL"), {
    target: { value: "file:///private/config" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "server" },
  });
  expect(screen.queryByLabelText("Command")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(
    await screen.findByText(
      "Enter a name and a command, or a valid HTTP(S) URL."
    )
  ).not.toBeNull();
  expect(add).not.toHaveBeenCalled();
});
it("selecting Global skills overrides the remembered workspace in listInstalled", async () => {
  const seed = defaultSeed();
  seed.prefs!.lastPickedWorkspaceId = seed.workspaces![0]!.id;
  const list = vi.fn(async (_context: unknown) => ({ skills: [] }));
  app = await renderApp("/library/skills", {
    seed,
    procedures: {
      skills: { listInstalled: os.skills.listInstalled.handler(list) },
    },
  });
  const choice = await screen.findByRole("combobox", { name: "Workspace" });
  await waitFor(() => expect(list).toHaveBeenCalled());
  fireEvent.change(choice, { target: { value: "" } });
  await waitFor(() =>
    expect((list.mock.calls.at(-1)![0] as { input: unknown }).input).toEqual({})
  );
  expect((choice as HTMLSelectElement).value).toBe("");
});
