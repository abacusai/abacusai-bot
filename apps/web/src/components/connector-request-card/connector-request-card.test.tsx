/**
 * R3-T32 (the card): the ask's copy, Connect / Not now, the inline fields of
 * a token connector, Stop connecting mid browser hop, and the error line.
 * The data half (snapshot, request/cleared, refresh before answering) is
 * `features/bots/chat/connector-requests.test.tsx`.
 */
import { CONNECTORS, connectUi } from "@abacus-ai/connectors/registry";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n, initI18n } from "#renderer/lib/i18n";
import type { ConnectorRequest } from "@abacus-ai/contract/contracts";

import { ConnectorRequestCard } from ".";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en-US");
});

const ask = (connectorId: string, label = "Slack"): ConnectorRequest =>
  ({
    requestId: "r1",
    connectorId,
    label,
    conversationKey: "k",
  }) as ConnectorRequest;

const hop = CONNECTORS.find((c) => connectUi(c) === "browser-hop")!;
const token = CONNECTORS.find((c) => connectUi(c) === "fields")!;

describe("ConnectorRequestCard", () => {
  it("asks with the provider and answers Connect / Not now", () => {
    const connect = vi.fn();
    const decline = vi.fn();
    render(
      <ConnectorRequestCard
        request={ask(hop.id)}
        busy={false}
        error={null}
        onConnect={connect}
        onDecline={decline}
      />
    );
    expect(screen.getByText("Slack is not connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Connect Slack/ }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(connect).toHaveBeenCalledWith(undefined);
    expect(decline).toHaveBeenCalledTimes(1);
  });

  it("mid browser hop, the secondary button stops the flow", () => {
    const stop = vi.fn();
    const decline = vi.fn();
    render(
      <ConnectorRequestCard
        request={ask(hop.id)}
        busy
        error={null}
        onConnect={() => {}}
        onDecline={decline}
        onStop={stop}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop connecting" }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(decline).not.toHaveBeenCalled();
  });

  it("a token connector submits its fields", () => {
    const connect = vi.fn();
    render(
      <ConnectorRequestCard
        request={ask(token.id, token.name)}
        busy={false}
        error={null}
        onConnect={connect}
        onDecline={() => {}}
      />
    );
    const button = screen.getByRole("button", { name: /Connect/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    for (const input of document.querySelectorAll("input"))
      fireEvent.change(input, { target: { value: "secret" } });
    fireEvent.click(button);
    const values = connect.mock.calls[0]![0] as Record<string, string>;
    expect(Object.values(values).every((value) => value === "secret")).toBe(
      true
    );
  });

  it("shows the error", () => {
    render(
      <ConnectorRequestCard
        request={ask(hop.id)}
        busy={false}
        error="Nope"
        onConnect={() => {}}
        onDecline={() => {}}
      />
    );
    expect(screen.getByRole("alert").textContent).toBe("Nope");
  });
});
