import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { renderApp } from "#renderer/test-support/app-harness";
const os = implement(contract);
it("R5-T23 invite refuses empty recipients and malformed email before sending", async () => {
  const send = vi.fn();
  const app = await renderApp("/settings/account?invite=gmail", {
    procedures: {
      referrals: {
        summary: os.referrals.summary.handler(() => ({
          inviteLink: "https://example.com/invite",
          invitesSent: 0,
          milestoneInvites: 5,
          milestoneCredits: 1,
          milestoneGranted: false,
          friendsJoined: 0,
          creditsPerFriend: 1,
          gmailConnected: true,
        })),
        gmailContacts: os.referrals.gmailContacts.handler(() => []),
        sendEmail: os.referrals.sendEmail.handler(send),
      },
    },
  });
  try {
    fireEvent.click(
      await screen.findByRole("button", { name: enUS.phase5.sendInvites })
    );
    expect(
      await screen.findByText(enUS.phase5.chooseRecipients)
    ).not.toBeNull();
    fireEvent.change(screen.getByLabelText(enUS.phase5.manualEmails), {
      target: { value: "invalid-email" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: enUS.phase5.sendInvites })
    );
    expect(await screen.findByText(enUS.phase5.invalidEmail)).not.toBeNull();
    expect(send).not.toHaveBeenCalled();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("preselects connected contacts and preserves opt-outs across refetch and channel changes", async () => {
  let contacts = [{ email: "grace@example.com", name: "Grace Example" }];
  const app = await renderApp("/settings/account?invite=gmail", {
    procedures: {
      referrals: {
        summary: os.referrals.summary.handler(() => ({
          inviteLink: "https://example.com/invite",
          invitesSent: 0,
          milestoneInvites: 5,
          milestoneCredits: 1,
          milestoneGranted: false,
          friendsJoined: 0,
          creditsPerFriend: 1,
          gmailConnected: true,
        })),
        gmailContacts: os.referrals.gmailContacts.handler(() => contacts),
        whatsappContacts: os.referrals.whatsappContacts.handler(() => [
          { chatId: "dummy-chat", name: "Sam Example" },
        ]),
      },
    },
  });
  try {
    const grace = await screen.findByRole("checkbox", {
      name: "Grace Example",
    });
    expect(grace.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(grace);
    contacts = [...contacts, { email: "sam@example.com", name: "New Example" }];
    await act(async () => {
      await app.router.options.context.queryClient.invalidateQueries({
        queryKey: app.transport.orpc.referrals.gmailContacts.queryKey({
          input: {},
        }),
      });
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole("checkbox", { name: "New Example" })
          .getAttribute("aria-checked")
      ).toBe("true")
    );
    expect(
      screen
        .getByRole("checkbox", { name: "Grace Example" })
        .getAttribute("aria-checked")
    ).toBe("false");
    await act(async () => {
      await app.router.navigate({
        to: "/settings/account",
        search: { invite: "whatsapp" },
      });
    });
    expect(
      (
        await screen.findByRole("checkbox", { name: "Sam Example" })
      ).getAttribute("aria-checked")
    ).toBe("true");
    await act(async () => {
      await app.router.navigate({
        to: "/settings/account",
        search: { invite: "gmail" },
      });
    });
    expect(
      (
        await screen.findByRole("checkbox", { name: "Grace Example" })
      ).getAttribute("aria-checked")
    ).toBe("false");
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("does not load or select recipients from an unconnected Gmail source", async () => {
  const load = vi.fn(() => [
    { email: "grace@example.com", name: "Grace Example" },
  ]);
  const app = await renderApp("/settings/account?invite=gmail", {
    procedures: {
      referrals: {
        summary: os.referrals.summary.handler(() => ({
          inviteLink: "https://example.com/invite",
          invitesSent: 0,
          milestoneInvites: 5,
          milestoneCredits: 1,
          milestoneGranted: false,
          friendsJoined: 0,
          creditsPerFriend: 1,
          gmailConnected: false,
        })),
        gmailContacts: os.referrals.gmailContacts.handler(load),
      },
    },
  });
  try {
    await screen.findByRole("button", { name: enUS.phase5.connectGmail });
    expect(load).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("checkbox", { name: "Grace Example" })
    ).toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
