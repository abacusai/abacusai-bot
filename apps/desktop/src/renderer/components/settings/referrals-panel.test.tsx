/**
 * The invite pickers: everyone listed starts ticked, a typed address or number
 * lands ticked at the top, and pressing Add on an empty or unusable box says so
 * instead of doing nothing.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values == null ? key : `${key} ${JSON.stringify(values)}`,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../connectors/connect-flow", () => ({
  useConnectFlow: () => ({ start: vi.fn(), cancel: vi.fn(), dialogs: null }),
}));
vi.mock("./messaging-connectors", () => ({
  useMessaging: () => ({
    snapshot: { platforms: [{ id: "whatsapp", state: "connected" }] },
  }),
}));

const { ReferralsPanel, parseEmails, parsePhones } =
  await import("./referrals-panel");

const sendReferralEmailInvites = vi.fn(async () => ({
  ok: true,
  sent: 1,
  skipped: 0,
  failed: 0,
  invitesSent: 1,
  milestoneCreditsGranted: 0,
  error: null,
}));
const sendReferralWhatsappInvites = vi.fn(async () => ({
  ok: true,
  sent: 1,
  skipped: 0,
  failed: 0,
  invitesSent: 2,
  milestoneCreditsGranted: 0,
  error: null,
}));

const byId = (id: string) =>
  document.querySelector<HTMLElement>(`[data-id="${id}"]`);

const renderPanel = () =>
  render(
    (
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ReferralsPanel />
      </QueryClientProvider>
    ) as JSX.Element
  );

beforeEach(() => {
  sendReferralEmailInvites.mockClear();
  sendReferralWhatsappInvites.mockClear();
  Object.assign(window, {
    api: {
      openExternal: vi.fn(),
      agent: {
        getReferralSummary: async () => ({
          inviteLink: "https://example.test/invite?token=abc",
          invitesSent: 0,
          milestoneInvites: 100,
          milestoneCredits: 5000,
          milestoneGranted: false,
          friendsJoined: 0,
          creditsPerFriend: 500,
          gmailConnected: true,
        }),
        listReferralGmailContacts: async () => [
          { email: "ada@example.test", name: "Ada" },
          { email: "bob@example.test", name: null },
        ],
        listReferralWhatsappContacts: async () => [
          { chatId: "Ada Lovelace", name: "Ada Lovelace" },
          { chatId: "Grace Hopper", name: "Grace Hopper" },
        ],
        sendReferralEmailInvites,
        sendReferralWhatsappInvites,
        onEvent: () => () => {},
      },
    },
  });
});

afterEach(cleanup);

describe("parsing what the user typed", () => {
  it("keeps the well-formed addresses, lower-cased and once each", () => {
    expect(
      parseEmails("Ada@Example.test, bob@example.test ada@example.test nope")
    ).toEqual([
      { id: "ada@example.test", label: "ada@example.test", detail: null },
      { id: "bob@example.test", label: "bob@example.test", detail: null },
    ]);
    expect(parseEmails("just words")).toEqual([]);
  });

  it("turns numbers into their international form and drops the rest", () => {
    expect(
      parsePhones("+1 (555) 010-0100, 91 98765 43210; ada@x.y, 12345")
    ).toEqual([
      { id: "+15550100100", label: "+1 (555) 010-0100", detail: null },
      { id: "+919876543210", label: "91 98765 43210", detail: null },
    ]);
  });
});

describe("the Gmail picker", () => {
  it("starts with everyone ticked and the send button counting them", async () => {
    renderPanel();
    await waitFor(() =>
      expect(byId("referrals-gmail-picker-count")?.textContent).toContain(
        '"selected":2,"total":2'
      )
    );
    expect(
      (byId("referrals-gmail-picker-send") as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("says so when Add is pressed on an empty box, and focuses it", async () => {
    renderPanel();
    await waitFor(() =>
      expect(byId("referrals-gmail-picker-count")).not.toBeNull()
    );

    fireEvent.click(byId("referrals-gmail-picker-manual-add")!);

    expect(byId("referrals-gmail-picker-manual-hint")?.textContent).toBe(
      "referrals.addEmailsEmpty"
    );
    expect(document.activeElement).toBe(byId("referrals-gmail-picker-manual"));
    expect(byId("referrals-gmail-picker-count")?.textContent).toContain(
      '"total":2'
    );
  });

  it("rejects text that is not an address, and clears the hint on the next keystroke", async () => {
    renderPanel();
    await waitFor(() =>
      expect(byId("referrals-gmail-picker-count")).not.toBeNull()
    );

    fireEvent.change(byId("referrals-gmail-picker-manual")!, {
      target: { value: "words" },
    });
    fireEvent.click(byId("referrals-gmail-picker-manual-add")!);
    expect(byId("referrals-gmail-picker-manual-hint")?.textContent).toBe(
      "referrals.addEmailsInvalid"
    );

    fireEvent.change(byId("referrals-gmail-picker-manual")!, {
      target: { value: "words@" },
    });
    expect(byId("referrals-gmail-picker-manual-hint")).toBeNull();
  });

  it("adds a typed address ticked at the top and sends it with the rest", async () => {
    renderPanel();
    await waitFor(() =>
      expect(byId("referrals-gmail-picker-count")).not.toBeNull()
    );

    fireEvent.change(byId("referrals-gmail-picker-manual")!, {
      target: { value: "New@Example.test" },
    });
    fireEvent.keyDown(byId("referrals-gmail-picker-manual")!, { key: "Enter" });

    expect(
      (byId("referrals-gmail-picker-manual") as HTMLInputElement).value
    ).toBe("");
    expect(byId("referrals-gmail-picker-count")?.textContent).toContain(
      '"selected":3,"total":3'
    );
    const first = byId("referrals-gmail-picker")?.querySelector("li");
    expect(first?.textContent).toContain("new@example.test");
    expect(
      first?.querySelector<HTMLInputElement>("input[type=checkbox]")?.checked
    ).toBe(true);

    fireEvent.click(byId("referrals-gmail-picker-send")!);
    await waitFor(() =>
      expect(sendReferralEmailInvites).toHaveBeenCalledWith(
        ["new@example.test", "ada@example.test", "bob@example.test"],
        expect.stringContaining("https://example.test/invite?token=abc")
      )
    );
  });

  it("ticks an unticked person again when they are re-added", async () => {
    renderPanel();
    await waitFor(() =>
      expect(byId("referrals-gmail-picker-count")).not.toBeNull()
    );
    const adaBox = byId("referrals-gmail-picker")!.querySelector(
      "input[type=checkbox]"
    )!;
    fireEvent.click(adaBox);
    expect(byId("referrals-gmail-picker-count")?.textContent).toContain(
      '"selected":1,"total":2'
    );

    fireEvent.change(byId("referrals-gmail-picker-manual")!, {
      target: { value: "ada@example.test" },
    });
    fireEvent.click(byId("referrals-gmail-picker-manual-add")!);

    expect(byId("referrals-gmail-picker-count")?.textContent).toContain(
      '"selected":2,"total":2'
    );
  });
});

describe("the WhatsApp picker", () => {
  it("lists the chats WhatsApp knows and takes a number for anyone else", async () => {
    renderPanel();
    await waitFor(() =>
      expect(byId("referrals-whatsapp-picker-count")?.textContent).toContain(
        '"selected":2,"total":2'
      )
    );

    fireEvent.click(byId("referrals-whatsapp-picker-manual-add")!);
    expect(byId("referrals-whatsapp-picker-manual-hint")?.textContent).toBe(
      "referrals.addPhonesEmpty"
    );

    fireEvent.change(byId("referrals-whatsapp-picker-manual")!, {
      target: { value: "+91 98765 43210" },
    });
    fireEvent.click(byId("referrals-whatsapp-picker-manual-add")!);

    expect(byId("referrals-whatsapp-picker-manual-hint")).toBeNull();
    expect(byId("referrals-whatsapp-picker-count")?.textContent).toContain(
      '"selected":3,"total":3'
    );
    fireEvent.click(byId("referrals-whatsapp-picker-send")!);
    await waitFor(() =>
      expect(sendReferralWhatsappInvites).toHaveBeenCalledWith(
        ["+919876543210", "Ada Lovelace", "Grace Hopper"],
        expect.any(String)
      )
    );
  });
});
