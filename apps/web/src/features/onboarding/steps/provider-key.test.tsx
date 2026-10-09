import { PROVIDER_KEY_FIELDS } from "@abacus-ai/contract/settings";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import type { Transport } from "#renderer/data/transport";
import { initI18n } from "#renderer/lib/i18n";

import { OnboardingProviderKey } from "./provider-key";
const validKey = "fixture-" + "x".repeat(32);
it.each(["save", "refresh"])(
  "%s failures retain valid keys and show retryable transport copy",
  async (stage) => {
    await initI18n();
    const save = vi.fn(async () => {});
    const saved = vi.fn(async () => {});
    (stage === "save" ? save : saved).mockRejectedValueOnce(
      new Error("offline")
    );
    const transport = {
      client: { settings: { keys: { save } } },
    } as unknown as Transport;
    render(<OnboardingProviderKey transport={transport} saved={saved} />);
    fireEvent.click(screen.getByRole("button", { name: "Paste a key" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Google Gemini/ })
    );
    const input = await screen.findByLabelText("Add API key");
    const key = "AIza" + "x".repeat(36);
    fireEvent.change(input, { target: { value: key } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Try again");
    expect(alert.textContent).toContain("Couldn't save that setting");
    expect(alert.textContent).not.toMatch(/invalid/i);
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect((input as HTMLInputElement).value).toBe(key);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }
);

it.each([true, false])(
  "returns focus to the key trigger after cancel, direct=%s",
  async (direct) => {
    await initI18n();
    render(
      <OnboardingProviderKey
        transport={{} as Transport}
        saved={async () => {}}
        provider={direct ? "gemini" : undefined}
      />
    );
    const trigger = screen.getByRole("button", {
      name: direct ? "Add API key" : "Paste a key",
    });
    fireEvent.click(trigger);
    if (!direct)
      fireEvent.click(
        await screen.findByRole("menuitem", { name: /Google Gemini/ })
      );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  }
);

it.each(["cancel", "escape", "close"])(
  "clears secrets and validation after %s before reopening or changing providers",
  async (close) => {
    await initI18n();
    const save = vi.fn(async () => {});
    render(
      <OnboardingProviderKey
        transport={
          { client: { settings: { keys: { save } } } } as unknown as Transport
        }
        saved={async () => {}}
      />
    );
    const open = async (name: string) => {
      fireEvent.click(screen.getByRole("button", { name: "Paste a key" }));
      fireEvent.click(await screen.findByRole("menuitem", { name }));
      return screen.findByLabelText("Add API key") as Promise<HTMLInputElement>;
    };
    const input = await open("Google Gemini (AI Studio)");
    fireEvent.change(input, { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    if (close === "escape") fireEvent.keyDown(input, { key: "Escape" });
    else
      fireEvent.click(
        screen.getByRole("button", {
          name: close === "cancel" ? "Cancel" : "Close",
        })
      );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await open("Google Gemini (AI Studio)")).value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText("Add API key"), {
      target: { value: validKey },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await open("DeepSeek")).value).toBe("");
  }
);

it.each(PROVIDER_KEY_FIELDS.filter((entry) => entry.kind === "model"))(
  "saves the selected $label key under its own provider",
  async ({ provider, label }) => {
    await initI18n();
    const save = vi.fn(async () => {}),
      saved = vi.fn(async () => {});
    render(
      <OnboardingProviderKey
        transport={
          { client: { settings: { keys: { save } } } } as unknown as Transport
        }
        saved={saved}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Paste a key" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: label }));
    fireEvent.change(await screen.findByLabelText("Add API key"), {
      target: { value: `  ${validKey}  ` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).toHaveBeenCalledWith({
      provider,
      key: validKey,
    });
    expect(saved).toHaveBeenCalledOnce();
  }
);
