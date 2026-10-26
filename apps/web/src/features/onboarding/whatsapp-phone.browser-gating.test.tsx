import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";

import { PhoneWhatsAppApp, whatsappChatQuery } from "./whatsapp";

beforeAll(initI18n);

const writeText = vi.fn<(text: string) => Promise<void>>();
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText },
});

afterEach(() => writeText.mockReset());

/** As the boot does: the chat is in the cache before the page mounts. */
const renderPhone = async (status: "linked" | "unlinked") => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const callApps = async () => ({
    available: true,
    status,
    phone: null,
    number: null,
  });
  await queryClient.prefetchQuery(whatsappChatQuery(callApps));
  return render(
    <QueryClientProvider client={queryClient}>
      <PhoneWhatsAppApp callApps={callApps} />
    </QueryClientProvider>
  );
};

it.each(["unlinked", "linked"] as const)(
  "offers the desktop app's address on the phone's WhatsApp page (%s)",
  async (status) => {
    await renderPhone(status);
    expect(
      await screen.findByRole("heading", {
        name: "Get the full app on your laptop",
      })
    ).toBeTruthy();
    // Under the connect step before linking, under the done screen after.
    expect(screen.queryByRole("dialog") != null).toBe(status === "unlinked");
    expect(screen.getByText("bot.abacus.ai")).toBeTruthy();
    const email = screen.getByRole("button", { name: "Email it to me" });
    const href = email.getAttribute("href") ?? "";
    expect(href.startsWith("mailto:?")).toBe(true);
    const params = new URLSearchParams(href.slice("mailto:?".length));
    expect(params.get("subject")).toBe("AbacusAI Bot for your laptop");
    expect(params.get("body")).toContain("https://bot.abacus.ai");

    writeText.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith("https://bot.abacus.ai");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  }
);

it("selects the address when the clipboard refuses", async () => {
  await renderPhone("linked");
  await screen.findByText("bot.abacus.ai");
  writeText.mockRejectedValue(new Error("denied"));
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  await waitFor(() =>
    expect(window.getSelection()?.toString()).toBe("bot.abacus.ai")
  );
  expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
});
