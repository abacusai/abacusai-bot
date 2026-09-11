/**
 * Backing out of a connect that has not finished.
 *
 * WhatsApp, Telegram and Discord connect by making the user wait — scan this
 * QR, finish in this login window. Enabling the platform is what starts that
 * wait, so a user who changes their mind mid-way had nothing to click: the
 * dialog offered only the thing they had decided against, and closing it left
 * the platform enabled and trying.
 */
import { fireEvent, render } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  MessagingPlatformId,
  MessagingPlatformInfo,
  MessagingPlatformState,
  MessagingSnapshot,
} from "#shared/messaging";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { MessagingConnectorDialog } = await import("./messaging-connectors");

const updatePlatform = vi.fn(async () => undefined);
const onClose = vi.fn();

const platform = (
  id: MessagingPlatformId,
  state: MessagingPlatformState,
  enabled = true
): MessagingPlatformInfo => ({
  id,
  nameKey: id,
  docsUrl: "",
  enabled,
  configured: true,
  state,
  errorMessage: null,
  fields: [],
  pendingCount: 0,
});

const snapshot = (one: MessagingPlatformInfo): MessagingSnapshot => ({
  platforms: [one],
  pending: [],
  approved: [],
  autoReplies: [],
  gatewayEnabled: true,
  autoApproveTools: false,
  respondToInbound: false,
  workspaceId: null,
  botId: null,
});

const show = (
  one: MessagingPlatformInfo,
  ...rest: MessagingPlatformInfo[]
): void => {
  render(
    (
      <MessagingConnectorDialog
        platformId={one.id}
        messaging={{
          snapshot: { ...snapshot(one), platforms: [one, ...rest] },
          updatePlatform,
          decidePairing: vi.fn(async () => undefined),
          updateSettings: vi.fn(async () => undefined),
          connectPlatform: vi.fn(async () => undefined),
        }}
        onClose={onClose}
      />
    ) as JSX.Element
  );
};

const cancelButton = (id: MessagingPlatformId): HTMLElement | null =>
  document.querySelector(`[data-id="messaging-cancel-connect-${id}"]`);

const doneButton = (id: MessagingPlatformId): HTMLElement | null =>
  document.querySelector(`[data-id="messaging-done-connect-${id}"]`);

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  (globalThis.window as unknown as { api: unknown }).api = {
    agent: { onEvent: () => () => {} },
  };
});

describe("cancelling a connect", () => {
  for (const id of ["whatsapp", "telegram", "discord"] as const) {
    it(`offers a way out while ${id} is still connecting`, () => {
      show(platform(id, "connecting"));

      const button = cancelButton(id);
      expect(button).not.toBeNull();

      fireEvent.click(button!);

      // Disabling is what stops the bridge or closes the login window, and it
      // is the path the card's Remove button already takes — so the platform
      // lands back on not-connected rather than a state of its own.
      expect(updatePlatform).toHaveBeenCalledWith({
        platformId: id,
        enabled: false,
      });
      expect(onClose).toHaveBeenCalled();
    });
  }

  it("is gone once the platform is actually connected", () => {
    show(platform("whatsapp", "connected"));

    expect(cancelButton("whatsapp")).toBeNull();
  });

  /**
   * Nothing to cancel before the connect has started — the card's Connect
   * button is what begins it, and an inert Cancel beside that would only ask
   * the user what it meant.
   */
  it("stays away while the platform is not enabled at all", () => {
    show(platform("whatsapp", "disabled", false));

    expect(cancelButton("whatsapp")).toBeNull();
  });
});

/**
 * Finishing a connect that worked.
 *
 * The connected state had no button at all: the QR disappeared, a green line
 * appeared, and the only way out was the close cross or a click outside —
 * neither of which looks like the end of a flow you were just walked through,
 * and neither of which tells you the thing you were waiting for has happened.
 */
describe("finishing a connect", () => {
  for (const id of ["whatsapp", "telegram", "discord"] as const) {
    it(`offers a way on once ${id} is connected`, () => {
      show(platform(id, "connected"));

      const button = doneButton(id);
      expect(button).not.toBeNull();

      fireEvent.click(button!);

      expect(onClose).toHaveBeenCalled();
    });
  }

  it("leaves the platform connected — it is a dismissal, not a decision", () => {
    show(platform("whatsapp", "connected"));

    fireEvent.click(doneButton("whatsapp")!);

    // Cancel is the button that changes something; this one only closes.
    expect(updatePlatform).not.toHaveBeenCalled();
  });

  it("replaces Cancel rather than joining it", () => {
    // The reciprocal — Cancel gone once connected — is in the suite above.
    show(platform("whatsapp", "connected"));

    expect(cancelButton("whatsapp")).toBeNull();
  });

  it("is not offered while the connect is still waiting", () => {
    show(platform("whatsapp", "connecting"));

    expect(doneButton("whatsapp")).toBeNull();
  });

  it("stays away while the platform is not enabled at all", () => {
    show(platform("whatsapp", "disabled", false));

    expect(doneButton("whatsapp")).toBeNull();
  });
});

/**
 * The shared Abacus AI bot, as a step rather than an extra.
 *
 * Signing in and linking the bot are one setup: the first lets the agent act
 * as you, the second is how you reach it from a phone. Presented as two
 * independent things, the card went green on the first alone and users went
 * off to DM a bot they had never linked.
 */
describe.each([
  ["discord", "abacus_discord"],
  ["telegram", "abacus_telegram"],
] as const)("%s's shared-bot link, once it is required", (id, laneId) => {
  const lane = (
    status: "unlinked" | "pending" | "linked" | "unavailable"
  ): MessagingPlatformInfo => ({
    ...platform(laneId, "connected"),
    sharedLink: { status },
  });

  const pairSharedChannel = vi.fn(async () => undefined);

  beforeEach(() => {
    (globalThis.window as unknown as { api: unknown }).api = {
      agent: {
        onEvent: () => () => {},
        pairSharedChannel,
        showMessagingLogin: vi.fn(),
      },
    };
  });

  it("withholds Done while the bot is not linked yet", () => {
    show(platform(id, "connected"), lane("pending"));

    expect(doneButton(id)).toBeNull();
    expect(cancelButton(id)).not.toBeNull();
    expect(
      document.querySelector(`[data-id="messaging-finish-link-${id}"]`)
    ).not.toBeNull();
  });

  it("says the setup is unfinished rather than Connected", () => {
    show(platform(id, "connected"), lane("pending"));

    const badge = document.querySelector(
      `[data-id="messaging-detail-${id}"] span`
    );
    expect(badge?.textContent).toContain("messaging.states.needs_link");
  });

  it("offers Done once the link lands", () => {
    show(platform(id, "connected"), lane("linked"));

    expect(doneButton(id)).not.toBeNull();
    expect(
      document.querySelector(`[data-id="messaging-finish-link-${id}"]`)
    ).toBeNull();
  });

  /**
   * The button that made the step look like a choice. Pairing starts itself
   * instead, so what the user sees is instructions, not an offer.
   */
  it("starts the pairing itself, with no Link button to press", () => {
    show(platform(id, "connected"), lane("unlinked"));

    expect(
      document.querySelector('[data-id="messaging-shared-pair"]')
    ).toBeNull();
    expect(pairSharedChannel).toHaveBeenCalledWith(laneId);
  });

  /**
   * A lane the server does not offer cannot be a required step — requiring it
   * would strand the card on "finish linking" with nothing to click.
   */
  it("falls back to the old, optional shape when the lane is unavailable", () => {
    show(platform(id, "connected"), lane("unavailable"));

    expect(doneButton(id)).not.toBeNull();
    expect(
      document.querySelector('[data-id="messaging-shared-pair"]')
    ).not.toBeNull();
  });

  /**
   * Closing a setup stopped halfway leaves nothing enabled behind it — both
   * the platform session and the lane go back to off.
   */
  it("backs both halves out when the dialog is closed unfinished", () => {
    show(platform(id, "connected"), lane("pending"));

    fireEvent.click(cancelButton(id)!);

    expect(updatePlatform).toHaveBeenCalledWith({
      platformId: id,
      enabled: false,
    });
    expect(updatePlatform).toHaveBeenCalledWith({
      platformId: laneId,
      enabled: false,
    });
  });
});
