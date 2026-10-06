/**
 * Library writes through useMutation (spec 01 §8.2): toggles flip at once
 * and a refusal (a thrown error or a `{ success: false }` answer) restores
 * them with one toast; a pending install cannot be sent twice; a success
 * refetches the key the write changed.
 */
import { contract } from "@abacus-ai/contract/contract";
import type { McpServerInfo } from "@abacus-ai/contract/contracts";
import type { MessagingSnapshot } from "@abacus-ai/contract/messaging";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { renderApp } from "#renderer/test-support/app-harness";

const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});

/** Calls the test answers, in order. */
const gate = () => {
  const waiting: Array<(ok: boolean) => void> = [];
  return {
    wait: () =>
      new Promise<boolean>((resolve) => waiting.push((ok) => resolve(ok))),
    pending: () => waiting.length,
    settle: (ok: boolean) => waiting.shift()!(ok),
  };
};

const findRow = async (id: string) => {
  await waitFor(() =>
    expect(document.querySelector(`[data-setting-id="${id}"]`)).not.toBeNull()
  );
  return within(
    document.querySelector<HTMLElement>(`[data-setting-id="${id}"]`)!
  );
};

it("a toolset switch flips at once and flips back with one toast when main refuses", async () => {
  const answer = gate();
  const setEnabled = vi.fn(async () => {
    if (!(await answer.wait())) throw new Error("refused");
    return { browser: false };
  });
  app = await renderApp("/library/tools", {
    procedures: {
      settings: {
        toolsets: {
          get: os.settings.toolsets.get.handler(() => ({ browser: true })),
          setEnabled: os.settings.toolsets.setEnabled.handler(setEnabled),
        },
      },
    },
  });
  const toggle = await (await findRow("browser")).findByRole("switch");
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(toggle.getAttribute("aria-checked")).toBe("false")
  );
  await waitFor(() => expect(answer.pending()).toBe(1));
  answer.settle(false);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(await screen.findAllByText(enUS.phase5.failed)).toHaveLength(1);
});

it("an MCP server's `{ success: false }` answer restores it with the generic copy; removing it refetches the list", async () => {
  let servers: McpServerInfo[] = [
    {
      id: "docs",
      name: "docs",
      config: { command: "docs-mcp" },
      isBuiltin: false,
    },
  ];
  const lists = vi.fn(() => servers);
  const answer = gate();
  app = await renderApp("/library/mcp", {
    procedures: {
      mcp: {
        list: os.mcp.list.handler(lists),
        setDisabled: os.mcp.setDisabled.handler(async () =>
          (await answer.wait())
            ? { success: true }
            : { success: false, error: "Server is locked" }
        ),
        remove: os.mcp.remove.handler(() => {
          servers = [];
          return { success: true };
        }),
      },
    },
  });
  const row = await findRow("docs");
  fireEvent.click(
    await row.findByRole("button", { name: enUS.phase5.disable })
  );
  expect(
    await row.findByRole("button", { name: enUS.phase5.enable })
  ).not.toBeNull();
  await waitFor(() => expect(answer.pending()).toBe(1));
  answer.settle(false);
  expect(
    await row.findByRole("button", { name: enUS.phase5.disable })
  ).not.toBeNull();
  // Enable/disable has always said only that it failed.
  expect(await screen.findByText(enUS.phase5.failed)).not.toBeNull();
  expect(screen.queryByText("Server is locked")).toBeNull();

  const reads = lists.mock.calls.length;
  fireEvent.click(row.getByRole("button", { name: enUS.phase5.remove }));
  const dialog = within(await screen.findByRole("alertdialog"));
  fireEvent.click(dialog.getByRole("button", { name: enUS.phase5.remove }));
  await waitFor(() => expect(lists.mock.calls.length).toBe(reads + 1));
  await waitFor(() =>
    expect(document.querySelector('[data-setting-id="docs"]')).toBeNull()
  );
});

it("a messaging setting flips at once and a refusal restores the snapshot", async () => {
  const snapshot = {
    gatewayEnabled: false,
    autoApproveTools: false,
    respondToInbound: false,
    workspaceId: null,
    botId: null,
    approved: [],
    pending: [],
    autoReplies: [],
    platforms: [],
  } as unknown as MessagingSnapshot;
  const answer = gate();
  app = await renderApp("/library/messaging", {
    procedures: {
      messaging: {
        snapshot: os.messaging.snapshot.handler(() => snapshot),
        updateSettings: os.messaging.updateSettings.handler(async () => {
          if (!(await answer.wait())) throw new Error("refused");
          return snapshot;
        }),
      },
    },
  });
  const toggle = await (await findRow("gatewayEnabled")).findByRole("switch");
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  await waitFor(() => expect(answer.pending()).toBe(1));
  answer.settle(false);
  await waitFor(() =>
    expect(toggle.getAttribute("aria-checked")).toBe("false")
  );
  expect(await screen.findByText(enUS.phase5.failed)).not.toBeNull();
});

it("a marketplace install is sent once and refetches the installed skills", async () => {
  const listed = vi.fn(() => ({ skills: [] }) as never);
  const answer = gate();
  const install = vi.fn(async () => {
    await answer.wait();
    return { success: true };
  });
  app = await renderApp("/library/skills?marketplace=true", {
    procedures: {
      skills: {
        listInstalled: os.skills.listInstalled.handler(listed),
        search: os.skills.search.handler(
          () =>
            ({
              skills: [
                {
                  id: "acme/lint",
                  skillId: "lint",
                  source: "acme",
                  name: "lint",
                  installs: 3,
                },
              ],
            }) as never
        ),
        install: os.skills.install.handler(install as never),
      },
    },
  });
  fireEvent.change(
    await screen.findByRole("textbox", { name: enUS.phase5.searchSkills }),
    { target: { value: "lint" } }
  );
  const button = await (
    await findRow("acme/lint")
  ).findByRole("button", { name: enUS.phase5.install });
  fireEvent.click(button);
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
  fireEvent.click(button);
  await waitFor(() => expect(answer.pending()).toBe(1));
  const reads = listed.mock.calls.length;
  answer.settle(true);
  expect(
    await (
      await findRow("acme/lint")
    ).findByRole("button", { name: enUS.phase5.installed })
  ).not.toBeNull();
  expect(install).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(listed.mock.calls.length).toBeGreaterThan(reads));
});

it("two MCP servers sign in at once: each disables only its own button", async () => {
  const servers: McpServerInfo[] = ["docs", "jira"].map((name) => ({
    id: name,
    name,
    config: { url: `https://${name}.example/mcp` },
    isBuiltin: false,
  }));
  const answer = gate();
  const signIn = vi.fn(async () => {
    await answer.wait();
    return { success: true };
  });
  app = await renderApp("/library/mcp", {
    procedures: {
      mcp: {
        list: os.mcp.list.handler(() => servers),
        oauthSignIn: os.mcp.oauthSignIn.handler(signIn),
      },
    },
  });
  // The sign-in button sits in the server's row footer, after its row.
  const footer = (name: string) =>
    within(
      document.querySelector<HTMLElement>(`[data-setting-id="${name}"]`)!
        .parentElement!
    );
  await findRow("docs");
  const docs = footer("docs").getByRole("button", { name: enUS.phase5.signIn });
  const jira = footer("jira").getByRole("button", { name: enUS.phase5.signIn });
  fireEvent.click(docs);
  await waitFor(() => expect(docs.hasAttribute("disabled")).toBe(true));
  expect(jira.hasAttribute("disabled")).toBe(false);
  fireEvent.click(jira);
  await waitFor(() => expect(answer.pending()).toBe(2));
  expect(jira.hasAttribute("disabled")).toBe(true);
  answer.settle(true);
  answer.settle(true);
  await waitFor(() => expect(docs.hasAttribute("disabled")).toBe(false));
  await waitFor(() => expect(jira.hasAttribute("disabled")).toBe(false));
  expect(signIn).toHaveBeenCalledTimes(2);
});

it("a pasted MCP import reads the clipboard inside the call: the import buttons wait for it", async () => {
  let paste!: (text: string) => void;
  const readText = vi.fn(
    () => new Promise<string>((resolve) => (paste = resolve))
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText },
  });
  const imported = vi.fn((_options: unknown) => ({ success: true }));
  app = await renderApp("/library/mcp", {
    procedures: {
      mcp: {
        list: os.mcp.list.handler(() => []),
        import: os.mcp.import.handler(imported as never),
      },
    },
  });
  const pasteButton = await screen.findByRole("button", {
    name: enUS.phase5.imports.json,
  });
  fireEvent.click(pasteButton);
  await waitFor(() => expect(pasteButton.hasAttribute("disabled")).toBe(true));
  fireEvent.click(pasteButton);
  expect(readText).toHaveBeenCalledTimes(1);
  paste('{"mcpServers":{}}');
  await waitFor(() => expect(imported).toHaveBeenCalledTimes(1));
  expect(imported.mock.calls[0]![0]).toMatchObject({
    input: { source: "json", json: '{"mcpServers":{}}' },
  });
  await waitFor(() => expect(pasteButton.hasAttribute("disabled")).toBe(false));
});
