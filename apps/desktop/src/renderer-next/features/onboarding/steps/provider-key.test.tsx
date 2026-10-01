import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import type { Transport } from "#next/data/transport";
import { initI18n } from "#next/lib/i18n";

import { OnboardingProviderKey } from "./provider-key";
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
    fireEvent.click(screen.getByRole("button", { name: "Add API key" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Google Gemini/ })
    );
    const input = await screen.findByLabelText("Add API key");
    const key = "AIza" + "x".repeat(36);
    fireEvent.change(input, { target: { value: key } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Try again");
    expect(alert.textContent).not.toMatch(/invalid/i);
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect((input as HTMLInputElement).value).toBe(key);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }
);
