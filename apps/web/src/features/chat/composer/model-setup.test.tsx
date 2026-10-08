import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelSetupBinding } from "#renderer/components/model-setup/types";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay, renderWithDb } from "../testing";
import { ModelChip } from "./chips";
import { clearDraft, draftStore } from "./draft-store";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  clearDraft("t-1");
});
const setup = (extra: Partial<ModelSetupBinding> = {}): ModelSetupBinding => ({
  status: "empty",
  providers: [
    { id: "abacus", label: "Abacus.AI", connected: false, connect: true },
    { id: "openrouter", label: "OpenRouter", connected: false, connect: true },
    { id: "openai", label: "OpenAI", connected: false, connect: false },
    { id: "anthropic", label: "Anthropic", connected: false, connect: false },
    { id: "gemini", label: "Google AI", connected: false, connect: false },
  ],
  localAvailable: false,
  connect: vi.fn(async () => true),
  save: vi.fn(async () => {}),
  retry: vi.fn(async () => {}),
  settings: vi.fn(),
  ...extra,
});
const binding = (state: ModelSetupBinding) => ({
  value: null,
  label: "Choose model",
  groups: [],
  onChange: vi.fn(),
  setup: state,
});
const open = async () => {
  fireEvent.click(
    screen.getByRole("button", { name: "No model set. Choose a model" })
  );
  await screen.findByRole("listbox");
};

describe("model setup in the composer", () => {
  it("names the unset chip and offers the setup paths in order", async () => {
    const state = setup({ localAvailable: true });
    const rendered = await renderWithDb(<ModelChip binding={binding(state)} />);
    cleanup = rendered.cleanup;
    await open();
    const rows = screen.getAllByRole("option");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Abacus.AIConnect",
      "OpenRouterConnect",
      "OpenAIAdd key",
      "AnthropicAdd key",
      "Google AIAdd key",
      "On this machineDownload",
      "All model settings",
    ]);
    fireEvent.click(rows[1]!);
    await waitFor(() =>
      expect(state.connect).toHaveBeenCalledWith("openrouter")
    );
  });

  it.each(["click", "Enter"])(
    "opens setup on %s without losing the draft",
    async (action) => {
      const relay = new FakeRelay();
      relay.emitAll(b.sessionReady());
      const rendered = await renderRelay(relay, "session", {
        blocked: "no-model",
        model: binding(setup()),
      });
      cleanup = rendered.cleanup;
      const composer = document.querySelector(
        '[data-slot="composer"]'
      ) as HTMLElement;
      const field = within(composer).getByRole("textbox");
      fireEvent.change(field, { target: { value: "Keep this draft" } });
      if (action === "click")
        fireEvent.click(within(composer).getByRole("button", { name: "Send" }));
      else fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
      await screen.findByText("Choose a model to send this message");
      expect(draftStore.state["t-1"]?.text).toBe("Keep this draft");
      expect((field as HTMLTextAreaElement).value).toBe("Keep this draft");
      expect(relay.stats.send).toHaveLength(0);
    }
  );

  it("keeps connection failures inline and lets users retry", async () => {
    const state = setup({
      connect: vi.fn().mockRejectedValueOnce(new Error("Connection failed")),
    });
    const rendered = await renderWithDb(<ModelChip binding={binding(state)} />);
    cleanup = rendered.cleanup;
    await open();
    fireEvent.click(screen.getByRole("option", { name: /Abacus.AI/ }));
    await screen.findByRole("alert");
    expect(screen.getByText("Connection failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /Abacus.AI/ }));
    await waitFor(() => expect(state.connect).toHaveBeenCalledTimes(2));
  });

  it("shows loading rows and an inline retry for catalog failure", async () => {
    const state = setup({ status: "loading" });
    const model = binding(state);
    const rendered = await renderWithDb(<ModelChip binding={model} />);
    cleanup = rendered.cleanup;
    fireEvent.click(screen.getByRole("button", { name: /No model set/ }));
    expect(await screen.findByLabelText("Loading")).toBeTruthy();
    expect(screen.queryByRole("option", { name: /OpenAI/ })).toBeNull();
    await rendered.rerender(
      <ModelChip binding={{ ...model, setup: { ...state, status: "error" } }} />
    );
    fireEvent.click(await screen.findByRole("option", { name: "Retry" }));
    await waitFor(() => expect(state.retry).toHaveBeenCalled());
  });

  it("saves a key inline then switches the open picker to runnable models", async () => {
    const state = setup();
    const model = binding(state);
    const rendered = await renderWithDb(<ModelChip binding={model} />);
    cleanup = rendered.cleanup;
    state.save = vi.fn(async () => {
      await rendered.rerender(
        <ModelChip
          binding={{
            ...model,
            label: "GPT",
            value: "openai/gpt",
            setup: { ...state, status: "ready" },
            groups: [
              {
                id: "openai",
                label: "OpenAI",
                items: [{ id: "openai/gpt", label: "GPT" }],
              },
            ],
          }}
        />
      );
    });
    await open();
    fireEvent.click(screen.getByRole("option", { name: /OpenAI/ }));
    fireEvent.change(await screen.findByLabelText("API key"), {
      target: { value: "sk-test-model-setup-key-000000000" },
    });
    fireEvent.submit(screen.getByLabelText("API key").closest("form")!);
    await waitFor(() =>
      expect(state.save).toHaveBeenCalledWith(
        "openai",
        "sk-test-model-setup-key-000000000"
      )
    );
    expect(await screen.findByRole("option", { name: "GPT" })).toBeTruthy();
    expect(await screen.findByText("Connected. Pick a model")).toBeTruthy();
  });
});
