import { contract } from "@abacus-ai/contract/contract";
import { LOCAL_MODEL_CATALOG } from "@abacus-ai/contract/local-models";
import type { UpdateStatus } from "@abacus-ai/contract/update";
import { implement } from "@orpc/server";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import {
  draftStore,
  clearDraft,
  updateDraft,
} from "#renderer/features/chat/composer/draft-store";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";
const os = implement(contract);
/** `update.events` as main serves it: the current status first, then held open. */
const servedStatus = (...statuses: UpdateStatus[]) =>
  os.update.events.handler(async function* ({ signal }) {
    for (const status of statuses) yield status;
    await new Promise<void>((resolve) =>
      signal?.addEventListener("abort", () => resolve(), { once: true })
    );
  });
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
  clearDraft("start");
});
const idle = {
  checking: false,
  available: false,
  downloading: false,
  downloaded: true,
  installing: false,
  error: null,
  progress: null,
  updateInfo: null,
  installStalled: false,
  criticalUpdate: false,
  failedPhase: null,
};
it("the update action persists in the global end slot across route actions", async () => {
  const install = vi.fn(async () => {});
  app = await renderApp("/routines", {
    procedures: {
      update: {
        events: servedStatus(idle),
        install: os.update.install.handler(install),
      },
    },
  });
  expect(
    await screen.findByRole("button", { name: "Relaunch to update" })
  ).not.toBeNull();
  await act(async () => {
    await app!.router.navigate({ to: "/settings/general" });
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Relaunch to update" })
  );
  await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
});
it("draft model adoption preserves draft content and returns to the remembered requester", async () => {
  const model = LOCAL_MODEL_CATALOG[0]!;
  updateDraft("start", () => ({
    text: "Keep this instruction",
    attachments: [],
    mode: "PLAN" as never,
  }));
  app = await renderApp("/bots/new", {
    procedures: {
      localModels: {
        state: os.localModels.state.handler(() => ({
          runtimeAvailable: true,
          totalMemoryBytes: 16 * 1024 ** 3,
          recommendedId: model.id,
          catalog: [model],
          installedIds: [model.id],
          download: null,
          servingId: null,
        })),
      },
    },
  });
  await act(async () => {
    await app!.router.navigate({
      to: "/settings/models",
      search: { provider: "local", for: "draft:start" },
    });
  });
  fireEvent.click(
    await screen.findByRole("button", { name: `Use ${model.label}` })
  );
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toBe("/bots/new")
  );
  expect(draftStore.state.start).toMatchObject({
    text: "Keep this instruction",
    model: `local/${model.id}`,
    mode: "PLAN",
  });
});
it("kind-based routine notification clicks do not require a session collection join", async () => {
  let send!: () => void;
  const ready = new Promise<void>((resolve) => {
    send = resolve;
  });
  const seed = defaultSeed();
  const routineId = seed.routines![0]!.id;
  app = await renderApp("/settings/general", {
    seed,
    procedures: {
      system: {
        events: os.system.events.handler(async function* ({ signal }) {
          await ready;
          yield {
            type: "notification-clicked",
            metadata: {
              kind: "routine",
              routineId,
              sessionId: "unhydrated-run",
            },
          };
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true })
          );
        }),
      },
    },
  });
  await act(async () => send());
  await waitFor(() => {
    expect(app!.router.state.location.pathname).toBe(`/routines/${routineId}`);
    expect(app!.router.state.location.search).toMatchObject({
      run: "unhydrated-run",
    });
  });
});
it("an exec-backend event invalidates only the backend and sandbox query families", async () => {
  let send!: () => void;
  const ready = new Promise<void>((resolve) => {
    send = resolve;
  });
  app = await renderApp("/settings/environment", {
    procedures: {
      settings: {
        events: os.settings.events.handler(async function* ({ signal }) {
          await ready;
          yield { type: "exec-backend", backend: "local" };
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true })
          );
        }),
      },
    },
  });
  const cache = app.router.options.context.queryClient;
  const invalidations = vi.spyOn(cache, "invalidateQueries");
  await act(async () => send());
  await waitFor(() =>
    expect(invalidations).toHaveBeenCalledWith({
      queryKey: app!.transport.orpc.settings.execBackend.get.key(),
    })
  );
  expect(invalidations).toHaveBeenCalledWith({
    queryKey: app.transport.orpc.settings.sandboxSupport.key(),
  });
  expect(
    invalidations.mock.calls.some(
      ([arg]) =>
        JSON.stringify(arg?.queryKey) ===
        JSON.stringify(app!.transport.orpc.models.list.key())
    )
  ).toBe(false);
});
