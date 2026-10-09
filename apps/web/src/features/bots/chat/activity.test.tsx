import { contract } from "@abacus-ai/contract/contract";
import { MODEL_CATALOG } from "@abacus-ai/contract/models";
import { implement } from "@orpc/server";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { fixtureSessions } from "#renderer/data/fixture-db/rows";
import * as b from "#renderer/features/chat/fixtures/builders";
import { FakeRelay } from "#renderer/features/chat/fixtures/relay";
import { renderApp, defaultSeed } from "#renderer/test-support/app-harness";

const os = implement(contract);
// The composer needs a configured model before it accepts a message.
const models = {
  models: {
    list: os.models.list.handler(() => [
      { ...MODEL_CATALOG[0]!, configured: true },
    ]),
  },
};
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});
it("the routed avatar follows actual reasoning/text streams and the send reaction", async () => {
  const relay = new FakeRelay({ threadId: "bot-test" });
  app = await renderApp("/bots/chief-of-staff", {
    ai: relay.ai,
    procedures: models,
    seed: {
      ...defaultSeed(),
      sessions: [
        {
          ...fixtureSessions()[0]!,
          id: "bot-test",
          workspaceId: "default",
          owner: {
            kind: "bot",
            botId: "chief-of-staff",
            role: "forever",
            key: "forever",
          },
          turn: {
            phase: "streaming",
            isBusy: true,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    },
  });
  const mood = () =>
    document
      .querySelector('[data-slot="bot-identity"] [data-mood]')
      ?.getAttribute("data-mood");
  await screen.findByTestId("bot-chat");
  await act(async () => {
    relay.emit(b.runStarted("r"));
    for (const chunk of b.reasoning("thinking", "Considering"))
      relay.emit(chunk);
  });
  await waitFor(() => expect(mood()).toBe("thinking"));
  await act(async () => {
    relay.emit(b.textStart("answer"));
    relay.emit(b.textDelta("answer", "Here is the report"));
  });
  await waitFor(() => expect(mood()).toBe("talking"));
  await act(async () => {
    relay.emit(b.textEnd("answer"));
    relay.emit(b.toolStart("reading", "read", "answer"));
  });
  await waitFor(() =>
    expect(document.querySelector("[data-bot-row]")?.textContent).toContain(
      "read"
    )
  );
  await act(async () => {
    relay.emit(b.runFinished("r"));
  });
  await waitFor(() => expect(mood()).not.toBe("talking"));
  const input = screen.getByRole("textbox", { name: /Message Chief of Staff/ });
  fireEvent.change(input, { target: { value: "Next" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  await waitFor(() => expect(mood()).toBe("wink"));
});
