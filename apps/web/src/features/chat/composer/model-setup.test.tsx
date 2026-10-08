import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelSetupBinding } from "#renderer/components/model-setup/types";
import { setMediaMatches } from "#renderer/test-support/media";
import { Toaster, toast } from "#renderer/ui/toast";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay, renderWithDb } from "../testing";
import { ModelChip } from "./chips";
import { clearDraft, draftStore, updateDraft } from "./draft-store";

const animate = vi.fn(
  (_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({
    cancel: vi.fn(),
  })
);
let toaster: ReturnType<typeof render> | undefined;
beforeEach(() => {
  animate.mockClear();
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: animate,
  });
});
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  clearDraft("t-1");
  toast.close();
  toaster?.unmount();
  toaster = undefined;
  delete (Element.prototype as Partial<Element>).animate;
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

  it.each([
    ["session", "click"],
    ["session", "Enter"],
    ["bot", "click"],
    ["bot", "Enter"],
  ] as const)(
    "draws attention on %s %s without changing the draft",
    async (skin, action) => {
      toaster = render(<Toaster />);
      const relay = new FakeRelay();
      relay.emitAll(b.sessionReady());
      const rendered = await renderRelay(relay, skin, {
        blocked: "no-model",
        model: binding(setup()),
      });
      cleanup = rendered.cleanup;
      const composer = document.querySelector(
        '[data-slot="composer"]'
      ) as HTMLElement;
      const field = within(composer).getByRole(
        "textbox"
      ) as HTMLTextAreaElement;
      fireEvent.change(field, { target: { value: "Keep this draft" } });
      act(() =>
        updateDraft("t-1", (draft) => ({
          ...draft,
          attachments: [
            {
              id: "attachment",
              name: "notes.txt",
              path: "/repo/notes.txt",
              state: "done",
            },
          ],
        }))
      );
      const draft = draftStore.state["t-1"];
      field.setSelectionRange(3, 7);
      field.scrollTop = 12;
      const send = () =>
        action === "click"
          ? fireEvent.click(
              within(composer).getByRole("button", { name: "Send" })
            )
          : fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
      send();
      const chip = within(composer).getByRole("button", {
        name: /No model set/,
      });
      expect(document.activeElement).toBe(chip);
      expect(chip.getAttribute("aria-invalid")).toBe("true");
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(animate).toHaveBeenCalledTimes(2);
      expect(animate.mock.calls[0]?.[0]).toEqual(
        [0, -4, 4, -4, 4, -2, 0].map((x) => ({
          transform: `translateX(${x}px)`,
        }))
      );
      send();
      expect(animate).toHaveBeenCalledTimes(4);
      expect(animate.mock.results[0]?.value.cancel).toHaveBeenCalledOnce();
      expect(animate.mock.results[1]?.value.cancel).toHaveBeenCalledOnce();
      await waitFor(() =>
        expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(1)
      );
      expect(
        within(
          document.querySelector('[data-slot="toast"]') as HTMLElement
        ).getByText("Choose a model to send this message")
      ).toBeTruthy();
      expect(draftStore.state["t-1"]).toBe(draft);
      expect(field.value).toBe("Keep this draft");
      expect(field.selectionStart).toBe(3);
      expect(field.selectionEnd).toBe(7);
      expect(field.scrollTop).toBe(12);
      expect(within(composer).getByRole("textbox")).toBe(field);
      expect(relay.stats.send).toHaveLength(0);
      fireEvent.click(chip);
      expect(await screen.findByRole("listbox")).toBeTruthy();
    }
  );

  it("uses only a ring pulse with reduced motion and clears invalid state once ready", async () => {
    setMediaMatches({ "(prefers-reduced-motion: reduce)": true });
    const ref = { current: null } as {
      current: import("./chips").ModelChipHandle | null;
    };
    const model = binding(setup());
    const rendered = await renderWithDb(
      <ModelChip ref={ref} binding={model} />
    );
    cleanup = rendered.cleanup;
    act(() => ref.current?.requestModel());
    const chip = screen.getByRole("button", { name: /No model set/ });
    expect(document.activeElement).toBe(chip);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0]?.[0]).toEqual([
      { opacity: 0 },
      { opacity: 1, offset: 0.25 },
      { opacity: 0 },
    ]);
    const description = document.getElementById(
      chip.getAttribute("aria-describedby")!
    );
    expect(description?.getAttribute("aria-live")).toBe("polite");
    expect(description?.textContent).toBe(
      "Choose a model to send this message"
    );
    expect(screen.queryByRole("listbox")).toBeNull();
    await rendered.rerender(
      <ModelChip
        ref={ref}
        binding={{
          ...model,
          setup: { ...model.setup, status: "ready" },
          label: "GPT",
        }}
      />
    );
    expect(
      screen.getByRole("combobox", { name: /GPT/ }).hasAttribute("aria-invalid")
    ).toBe(false);
  });

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
    expect(await screen.findByRole("option", { name: "GPT" })).toBeTruthy();
    expect(await screen.findByText("Connected. Pick a model")).toBeTruthy();
  });
  it("focuses the setup list and returns focus to the chip on Escape", async () => {
    const rendered = await renderWithDb(
      <ModelChip binding={binding(setup())} />
    );
    cleanup = rendered.cleanup;
    const chip = screen.getByRole("button", {
      name: "No model set. Choose a model",
    });
    fireEvent.click(chip);
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector("[cmdk-root]"))
    );
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(chip));
  });

  it("explains a connected provider with no models when key rows are withheld", async () => {
    const state = setup({
      providers: [
        { id: "abacus", label: "Abacus.AI", connected: true, connect: true },
      ],
    });
    const rendered = await renderWithDb(<ModelChip binding={binding(state)} />);
    cleanup = rendered.cleanup;
    await open();
    expect(screen.queryByRole("option", { name: /OpenAI/ })).toBeNull();
    expect(
      screen.queryByRole("option", { name: /On this machine/ })
    ).toBeNull();
    expect(
      screen.getByText(
        "Connected, but no models are available. Open the provider settings to check access."
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /Abacus.AI/ }));
    expect(state.settings).toHaveBeenCalledWith("abacus");
    expect(state.connect).not.toHaveBeenCalled();
  });
});
