/**
 * Settings writes through useMutation (spec 01 §8.2): an optimistic value
 * shows at once and a refusal restores it, a pending write cannot be sent
 * twice, and a success refetches the key the write changed.
 */
import { contract } from "@abacus-ai/contract/contract";
import type {
  DeviceStatus,
  ExecBackendState,
} from "@abacus-ai/contract/contracts";
import {
  LOCAL_MODEL_CATALOG,
  type LocalModelState,
} from "@abacus-ai/contract/local-models";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";

const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});

/** A call the test answers: `next()` waits for it, `settle()` ends it. */
const gate = () => {
  const waiting: Array<{ resolve(): void; reject(e: Error): void }> = [];
  return {
    wait: () =>
      new Promise<void>((resolve, reject) => waiting.push({ resolve, reject })),
    pending: () => waiting.length,
    settle: (ok: boolean) => {
      const call = waiting.shift()!;
      if (ok) call.resolve();
      else call.reject(new Error("refused"));
    },
  };
};

const row = (id: string) =>
  within(document.querySelector<HTMLElement>(`[data-setting-id="${id}"]`)!);
const findRow = async (id: string) => {
  await waitFor(() =>
    expect(document.querySelector(`[data-setting-id="${id}"]`)).not.toBeNull()
  );
  return row(id);
};

it("an execution backend switches at once, cannot be sent twice, and a refusal puts the previous one back", async () => {
  let state: ExecBackendState = {
    selected: "local",
    effective: "local",
    statuses: [
      { id: "local", ready: true },
      { id: "docker", ready: true },
    ] as ExecBackendState["statuses"],
  };
  const reads = vi.fn(() => state);
  const answer = gate();
  const set = vi.fn(async ({ input }: { input: { backend: string } }) => {
    await answer.wait();
    state = {
      ...state,
      selected: input.backend,
      effective: input.backend,
    } as ExecBackendState;
    return state;
  });
  app = await renderApp("/settings/environment", {
    procedures: {
      settings: {
        execBackend: {
          get: os.settings.execBackend.get.handler(reads),
          set: os.settings.execBackend.set.handler(set as never),
        },
      },
    },
  });
  fireEvent.click(
    await row("backend-docker").findByRole("button", { name: enUS.phase5.use })
  );
  // Optimistic: docker is in use before main answers.
  expect(
    await row("backend-docker").findByText(enUS.phase5.inUse)
  ).not.toBeNull();
  const local = row("backend-local").getByRole("button", {
    name: enUS.phase5.use,
  });
  expect(local.hasAttribute("disabled")).toBe(true);
  fireEvent.click(local);
  await waitFor(() => expect(answer.pending()).toBe(1));
  expect(set).toHaveBeenCalledTimes(1);

  answer.settle(false);
  expect(
    await row("backend-local").findByText(enUS.phase5.inUse)
  ).not.toBeNull();
  expect(state.selected).toBe("local");

  // The refused write stays pending (its buttons disabled) until its
  // settle-time refetch answers; a click before that sends nothing.
  const docker = await row("backend-docker").findByRole("button", {
    name: enUS.phase5.use,
  });
  await waitFor(() => expect(docker.hasAttribute("disabled")).toBe(false));
  const before = reads.mock.calls.length;
  fireEvent.click(docker);
  await waitFor(() => expect(answer.pending()).toBe(1));
  answer.settle(true);
  // The settled write refetches settings.execBackend.get.
  await waitFor(() => expect(reads.mock.calls.length).toBe(before + 1));
  expect(row("backend-docker").getByText(enUS.phase5.inUse)).not.toBeNull();
});

it("launch at login flips at once and flips back with a toast when main refuses", async () => {
  const answer = gate();
  const set = vi.fn(async () => {
    await answer.wait();
    return { openAtLogin: true };
  });
  app = await renderApp("/settings/general", {
    procedures: {
      system: {
        loginItem: {
          get: os.system.loginItem.get.handler(() => ({ openAtLogin: false })),
          set: os.system.loginItem.set.handler(set),
        },
      },
    },
  });
  const toggle = await row("launchAtLogin").findByRole("switch");
  await waitFor(() => expect(toggle.hasAttribute("data-disabled")).toBe(false));
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  await waitFor(() => expect(answer.pending()).toBe(1));
  answer.settle(false);
  await waitFor(() =>
    expect(toggle.getAttribute("aria-checked")).toBe("false")
  );
  expect(await screen.findByText(enUS.phase5.saveFailed)).not.toBeNull();
});

it("installing Maestro is sent once and refetches the device status", async () => {
  let status = {
    available: true,
    ios: true,
    android: false,
    maestro: false,
    enabled: true,
    approval: "ask",
  } as DeviceStatus;
  const reads = vi.fn(() => status);
  const answer = gate();
  const install = vi.fn(async () => {
    await answer.wait();
    status = { ...status, maestro: true };
    return { success: true, status };
  });
  app = await renderApp("/settings/devices", {
    procedures: {
      devices: {
        status: os.devices.status.handler(reads),
        installMaestro: os.devices.installMaestro.handler(install),
      },
    },
  });
  const button = await row("device-maestro").findByRole("button", {
    name: enUS.phase5.install,
  });
  fireEvent.click(button);
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
  fireEvent.click(button);
  await waitFor(() => expect(answer.pending()).toBe(1));
  answer.settle(true);
  expect(
    await row("device-maestro").findByText(enUS.phase5.detected)
  ).not.toBeNull();
  expect(install).toHaveBeenCalledTimes(1);
  expect(reads.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it("a local model install is sent once, refetches its state and invalidates the cached catalog", async () => {
  const model = LOCAL_MODEL_CATALOG[0]!;
  const state: LocalModelState = {
    runtimeAvailable: true,
    totalMemoryBytes: 16 * 1024 ** 3,
    recommendedId: model.id,
    catalog: [model],
    installedIds: [],
    download: null,
    servingId: null,
  };
  const reads = vi.fn(() => state);
  const lists = vi.fn(() => []);
  const answer = gate();
  const install = vi.fn(async () => {
    await answer.wait();
    state.installedIds = [model.id];
    return { ok: true as const, model: `local/${model.id}` };
  });
  app = await renderApp("/settings/models?provider=local", {
    procedures: {
      localModels: {
        state: os.localModels.state.handler(reads),
        install: os.localModels.install.handler(install),
      },
      models: { list: os.models.list.handler(lists) },
    },
  });
  app.router.options.context!.queryClient.setQueryData(
    app.transport.orpc.models.list.queryKey({ input: {} }),
    []
  );
  const button = await (
    await findRow(`local-${model.id}`)
  ).findByRole("button", {
    name: enUS.phase5.download,
  });
  fireEvent.click(button);
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
  fireEvent.click(button);
  await waitFor(() => expect(answer.pending()).toBe(1));
  const stateReads = reads.mock.calls.length;
  answer.settle(true);
  expect(
    await row(`local-${model.id}`).findByText(enUS.phase5.installed)
  ).not.toBeNull();
  expect(install).toHaveBeenCalledTimes(1);
  expect(reads.mock.calls.length).toBeGreaterThan(stateReads);
  // No incidental sidebar observer: refresh this cached catalog when a picker next opens.
  await waitFor(() =>
    expect(
      app!.router.options.context!.queryClient.getQueryState(
        app!.transport.orpc.models.list.queryKey({ input: {} })
      )?.isInvalidated
    ).toBe(true)
  );
});

it("saving logs is sent once while the save dialog is open", async () => {
  const answer = gate();
  const save = vi.fn(async () => {
    await answer.wait();
    return { filePath: null };
  });
  app = await renderApp("/settings/about", {
    procedures: {
      system: { logs: { save: os.system.logs.save.handler(save) } },
    },
  });
  const button = await row("logs").findByRole("button", {
    name: enUS.phase5.saveLogs,
  });
  fireEvent.click(button);
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
  fireEvent.click(button);
  await waitFor(() => expect(answer.pending()).toBe(1));
  answer.settle(true);
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  expect(save).toHaveBeenCalledTimes(1);
});

const localModel = () => {
  const model = LOCAL_MODEL_CATALOG[0]!;
  const state: LocalModelState = {
    runtimeAvailable: true,
    totalMemoryBytes: 16 * 1024 ** 3,
    recommendedId: model.id,
    catalog: [model],
    installedIds: [],
    download: null,
    servingId: null,
  };
  const answer = gate();
  const procedures = {
    localModels: {
      state: os.localModels.state.handler(() => state),
      install: os.localModels.install.handler(async () => {
        await answer.wait();
        state.installedIds = [model.id];
        return { ok: true as const, model: `local/${model.id}` };
      }),
    },
  };
  return { model, answer, procedures };
};

it("install-and-use stays pending through the adoption, and a failed adoption shows inline", async () => {
  const { model, answer, procedures } = localModel();
  app = await renderApp("/settings/models?provider=local&for=session:gone", {
    procedures,
  });
  app.router.options.context!.queryClient.setQueryData(
    app.transport.orpc.models.list.queryKey({ input: {} }),
    []
  );
  const button = await (
    await findRow(`local-${model.id}`)
  ).findByRole("button", { name: enUS.phase5.installUse });
  fireEvent.click(button);
  await waitFor(() => expect(answer.pending()).toBe(1));
  answer.settle(true);
  // The target thread is gone: adopting it fails, on the page.
  expect((await screen.findByRole("alert")).textContent).toBe(
    enUS.phase5.threadGone
  );
});

it("an install answered after leaving its target adopts nothing", async () => {
  const { model, answer, procedures } = localModel();
  const seed = defaultSeed();
  const session = seed.sessions!.find((s) => !s.owner && !s.routineId)!;
  app = await renderApp(
    `/settings/models?provider=local&for=session:${session.id}`,
    { seed, procedures }
  );
  fireEvent.click(
    await (
      await findRow(`local-${model.id}`)
    ).findByRole("button", { name: enUS.phase5.installUse })
  );
  await waitFor(() => expect(answer.pending()).toBe(1));
  await app.router.navigate({
    to: "/settings/models",
    search: { provider: "local" },
  });
  answer.settle(true);
  expect(
    await (await findRow(`local-${model.id}`)).findByText(enUS.phase5.installed)
  ).not.toBeNull();
  expect(app.collections.sessions.get(session.id)?.model).not.toBe(
    `local/${model.id}`
  );
  expect(app.router.state.location.pathname).toBe("/settings/models");
  expect(screen.queryByRole("alert")).toBeNull();
});
