import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

import { defaultSeed, renderApp } from "#next/test-support/app-harness";
import { contract } from "#shared/contract";
import {
  LOCAL_MODEL_CATALOG,
  type LocalModelState,
} from "#shared/local-models";
const os = implement(contract);
it.each([false, true])(
  "R5-T23 %s installed local model adopts into a session and returns",
  async (installed) => {
    const seed = defaultSeed();
    const session = seed.sessions!.find((s) => !s.owner && !s.routineId)!;
    const model = LOCAL_MODEL_CATALOG[0]!;
    const state: LocalModelState = {
      runtimeAvailable: true,
      totalMemoryBytes: 16 * 1024 ** 3,
      recommendedId: model.id,
      catalog: [model],
      installedIds: installed ? [model.id] : [],
      download: null,
      servingId: null,
    };
    const app = await renderApp(
      `/settings/models?provider=local&for=session:${session.id}`,
      {
        seed,
        procedures: {
          localModels: {
            state: os.localModels.state.handler(() => state),
            install: os.localModels.install.handler(() => {
              state.installedIds = [model.id];
              return { ok: true, model: `local/${model.id}` };
            }),
          },
          agent: { setModel: os.agent.setModel.handler(() => undefined) },
        },
      }
    );
    try {
      fireEvent.click(
        await screen.findByRole("button", {
          name: installed ? `Use ${model.label}` : "Install and use",
        })
      );
      await waitFor(() =>
        expect(app.collections.sessions.get(session.id)?.model).toBe(
          `local/${model.id}`
        )
      );
      await waitFor(() =>
        expect(app.router.state.location.pathname).toBe(
          `/sessions/${session.id}`
        )
      );
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  }
);
