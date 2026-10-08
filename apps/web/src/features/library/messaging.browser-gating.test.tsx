import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { renderApp } from "#renderer/test-support/app-harness";

import { WebMessagingPage } from "./whatsapp-phone";

const { callApps } = vi.hoisted(() => ({ callApps: vi.fn() }));
vi.mock("#platform/whatsapp-phone", () => ({
  WebMessagingPage: () => <WebMessagingPage callApps={callApps} />,
}));

it("web WhatsApp keeps phone pairing in a shareable dialog and restores its opener", async () => {
  callApps.mockImplementation(async (service: string) =>
    service === "linkAbacusBotWhatsApp"
      ? { status: "pending", code: "K7Q49ZWP", phone: "+15550001234" }
      : { status: "unlinked", code: null, phone: null }
  );
  const app = await renderApp("/library/messaging");
  try {
    const connect = await screen.findByRole("button", { name: "Connect" });
    await waitFor(() =>
      expect((connect as HTMLButtonElement).disabled).toBe(false)
    );
    connect.focus();
    fireEvent.click(connect);
    await screen.findByRole("dialog", { name: enUS.web.whatsapp.dialogTitle });
    expect(app.router.state.location.href).toBe(
      "/library/messaging?platform=whatsapp"
    );
    fireEvent.change(screen.getByLabelText(enUS.web.whatsapp.numberLabel), {
      target: { value: "+15550001234" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: enUS.web.whatsapp.getCode })
    );
    await screen.findByText("K7Q4-9ZWP");
    expect(callApps).toHaveBeenCalledWith(
      "linkAbacusBotWhatsApp",
      expect.objectContaining({ phoneNumber: "+15550001234" })
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(app.router.state.location.href).toBe("/library/messaging");
    await waitFor(() => expect(document.activeElement).toBe(connect));
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("web WhatsApp management opens directly and unlink retains the connection behavior", async () => {
  callApps.mockImplementation(async (service: string) =>
    service === "getAbacusBotWhatsAppStatus"
      ? { status: "linked", code: null, phone: "+15550001234" }
      : {}
  );
  const app = await renderApp("/library/messaging?platform=whatsapp");
  try {
    await screen.findByRole("dialog");
    const chat = await screen.findByRole("button", {
      name: enUS.web.whatsapp.openChat,
    });
    expect(chat.getAttribute("href")).toBe("https://wa.me/15550001234");
    fireEvent.click(
      screen.getByRole("button", { name: enUS.web.whatsapp.unlink })
    );
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(
      confirm.querySelector('button[type="submit"]') ??
        [...confirm.querySelectorAll("button")].find(
          (button) => button.textContent === enUS.web.whatsapp.unlink
        )!
    );
    await waitFor(() =>
      expect(callApps).toHaveBeenCalledWith("unlinkAbacusBotWhatsApp", {})
    );
    await waitFor(() =>
      expect(app.router.state.location.search.platform).toBeUndefined()
    );
    await act(() => {
      app.router.history.back();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
