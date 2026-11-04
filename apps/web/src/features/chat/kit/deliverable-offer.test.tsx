import { contract } from "@abacus-ai/contract/contract";
import type { DeliverableOfferCard } from "@abacus-ai/contract/deliverable-offer";
import { EMPTY_DELIVERABLE_OFFER_CARD } from "@abacus-ai/contract/deliverable-offer";
import { implement } from "@orpc/server";
import type { StreamChunk } from "@tanstack/ai";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay } from "../testing";

const ANSWER = [
  "Short version: Notion for one shared space, Obsidian for plain files, Logseq for daily logs.",
  "",
  "## At a glance",
  "",
  "| | Notion | Obsidian | Logseq |",
  "| --- | --- | --- | --- |",
  "| Collaboration | Built in | Paid Sync | Limited |",
  "| Offline | Partial | Full | Full |",
  "",
  "## Meeting notes",
  "",
  "Notion's templates and database views make recurring meetings easy to keep, with one database and a template per meeting type. ".repeat(
    4
  ),
  "",
  "## The wiki",
  "",
  "For a small wiki several people edit, Notion's permissions, comments and page history work without any setup at all. ".repeat(
    4
  ),
].join("\n");

const REQUEST =
  "Turn your last answer into a polished report I can keep and share, saved as a PDF in the workspace.";

let current: Awaited<ReturnType<typeof renderRelay>> | undefined;
afterEach(async () => {
  await current?.cleanup();
  current = undefined;
});

const turn = (
  runId: string,
  ask: string,
  ...reply: StreamChunk[]
): StreamChunk[] => [
  b.runStarted(runId),
  ...b.text(`${runId}-u`, "user", ask),
  ...reply,
  b.runFinished(runId, "success"),
];

const answered = (runId: string, text = ANSWER): StreamChunk[] =>
  turn(
    runId,
    "Compare Notion, Obsidian and Logseq",
    ...b.text(`${runId}-a`, "assistant", text)
  );

/**
 * The chat with `before` in its log when it opens, then `live` arriving while
 * it is on screen, as a reply that just came in.
 */
const mount = async ({
  before = [] as StreamChunk[],
  live = [] as StreamChunk[],
  card = undefined as DeliverableOfferCard | undefined,
  readOnly = false,
} = {}) => {
  const steps: Array<{ step: string; detail?: string }> = [];
  const relay = new FakeRelay();
  relay.emitAll([...b.sessionReady(), ...before]);
  const os = implement(contract);
  current = await renderRelay(
    relay,
    "session",
    readOnly ? { readOnly: { reason: "routine" } } : {},
    {},
    undefined,
    {
      system: {
        funnelStep: os.system.funnelStep.handler(({ input }) => {
          steps.push(input);
        }),
      },
    }
  );
  if (card != null)
    await act(() =>
      current!.db.updatePrefs({ dismissals: { deliverableOffer: card } })
    );
  await act(async () => relay.emitAll(live));
  const record = () =>
    current!.db.collections.prefs.get("app")?.dismissals.deliverableOffer;
  return { relay, steps, record };
};

const offer = () => document.querySelector('[data-slot="deliverable-offer"]');

/** Lets every write settle, so a row that is coming has come. */
const settled = async () => {
  for (let index = 0; index < 4; index += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
};

describe("DeliverableOfferRow", () => {
  it("offers a report under a long comparison that made no file, once", async () => {
    const h = await mount({ live: answered("r1") });
    const button = await screen.findByRole("button", {
      name: "Turn into a report",
    });
    expect(button.closest('[data-slot="deliverable-offer"]')).toBeTruthy();
    await waitFor(() =>
      expect(h.record()).toMatchObject({
        shownOffer: "r1-a",
        shownThread: h.relay.threadId,
        shownTurn: 1,
        answered: null,
      })
    );
    await settled();
    expect(h.steps).toEqual([
      { step: "deliverable_offer_shown", detail: "report_session" },
    ]);
  });

  it("sends the request as the user's message and records the tap", async () => {
    const h = await mount({ live: answered("r1") });
    fireEvent.click(
      await screen.findByRole("button", { name: "Turn into a report" })
    );
    await waitFor(() => expect(h.relay.stats.send).toHaveLength(1));
    expect(JSON.stringify(h.relay.stats.send[0])).toContain(REQUEST);
    expect(offer()).toBeNull();
    await waitFor(() =>
      expect(h.record()).toMatchObject({ answered: "r1-a", misses: 0 })
    );
    expect(h.steps.map((step) => step.step)).toContain(
      "deliverable_offer_clicked"
    );
  });

  it("closing it hides it and counts the close", async () => {
    const h = await mount({ live: answered("r1") });
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(offer()).toBeNull();
    await waitFor(() =>
      expect(h.record()).toMatchObject({
        answered: "r1-a",
        misses: 1,
        dismissed: 1,
      })
    );
    expect(h.steps.map((step) => step.step)).toContain(
      "deliverable_offer_dismissed"
    );
  });

  it.each([
    ["a short answer", answered("r1", "Lisbon.")],
    [
      "a turn that wrote a file",
      turn(
        "r1",
        "Write up the comparison",
        b.textStart("r1-a"),
        ...b.toolCall("c1", "write", "r1-a", {
          file_path: "/repo/notes.md",
        }),
        b.toolResult("c1", { text: "Wrote notes.md" }),
        b.textDelta("r1-a", ANSWER),
        b.textEnd("r1-a")
      ),
    ],
    [
      "a failed turn",
      [
        b.runStarted("r1"),
        ...b.text("r1-u", "user", "Compare them"),
        ...b.text("r1-a", "assistant", ANSWER),
        b.runError("r1", { message: "Connection lost" }),
      ],
    ],
  ])("never under %s", async (_, live) => {
    await mount({ live });
    await settled();
    expect(offer()).toBeNull();
  });

  it("is not offered on a reply that was already there when the chat opened", async () => {
    await mount({ before: answered("r1") });
    await settled();
    expect(offer()).toBeNull();
  });

  it("is not offered in a read-only chat", async () => {
    await mount({ live: answered("r1"), readOnly: true });
    await settled();
    expect(offer()).toBeNull();
  });

  it("skips the reply right after the last one offered on", async () => {
    const h = await mount({
      before: answered("r1"),
      card: {
        ...EMPTY_DELIVERABLE_OFFER_CARD,
        shownOffer: "r1-a",
        shownThread: "t-1",
        shownTurn: 1,
        answered: "r1-a",
      },
      live: answered("r2"),
    });
    await settled();
    expect(offer()).toBeNull();
    expect(h.steps).toEqual([]);
  });

  it("stops after three offers in a row are passed over", async () => {
    const h = await mount({
      card: {
        ...EMPTY_DELIVERABLE_OFFER_CARD,
        shownOffer: "old",
        shownThread: "t-old",
        shownTurn: 1,
        misses: 2,
      },
      live: answered("r1"),
    });
    await settled();
    expect(offer()).toBeNull();
    expect(h.steps).toEqual([]);
  });

  it("counts a passed-over offer as a miss when the next one shows", async () => {
    const h = await mount({
      card: {
        ...EMPTY_DELIVERABLE_OFFER_CARD,
        shownOffer: "old",
        shownThread: "t-old",
        shownTurn: 1,
        misses: 1,
      },
      live: answered("r1"),
    });
    await screen.findByRole("button", { name: "Turn into a report" });
    await waitFor(() =>
      expect(h.record()).toMatchObject({ shownOffer: "r1-a", misses: 2 })
    );
  });
});
