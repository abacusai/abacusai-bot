import { implement } from "@orpc/server";
import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { renderApp } from "#renderer/test-support/app-harness";
import { contract } from "@abacus-ai/contract/contract";
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
