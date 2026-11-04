import { describe, expect, it } from "vitest";

import {
  type DeliverableOfferCard,
  deliverableOfferAllowed,
  deliverableOfferKind,
  EMPTY_DELIVERABLE_OFFER_CARD,
} from "./deliverable-offer";

const prose = (sentences: number): string =>
  Array.from(
    { length: sentences },
    (_, index) =>
      `Point ${index + 1} weighs the trade-offs a small team meets when it picks a tool and keeps using it.`
  ).join(" ");

const sections = (count: number, body: string): string =>
  Array.from(
    { length: count },
    (_, index) => `## Section ${index + 1}\n\n${body}`
  ).join("\n\n");

const table = [
  "| | A | B |",
  "| --- | --- | --- |",
  "| Price | $5 | $8 |",
  "| Offline | Yes | No |",
].join("\n");

const list = (count: number): string =>
  Array.from({ length: count }, (_, index) => `- Step ${index + 1}`).join("\n");

describe("deliverableOfferKind", () => {
  it.each([
    ["a short answer", "Lisbon.", null],
    ["a paragraph", prose(4), null],
    ["long prose with no structure", prose(12), null],
    ["very long prose", prose(28), "doc"],
    ["two sections", sections(2, prose(7)), "doc"],
    ["a plan with steps", `${prose(13)}\n\n${list(5)}`, "doc"],
    ["three sections", sections(3, prose(5)), "report"],
    ["a comparison table", `${prose(13)}\n\n${table}`, "report"],
    [
      "mostly code",
      `${prose(13)}\n\n\`\`\`ts\n${"const x = 1;\n".repeat(200)}\`\`\``,
      null,
    ],
    [
      "short prose around a long code block",
      `${prose(2)}\n\n\`\`\`ts\n${"const x = 1;\n".repeat(200)}\`\`\``,
      null,
    ],
    [
      "a structured answer in Japanese",
      `## 概要\n\n${"小さなチームが道具を選ぶときの利点と欠点を比べます。".repeat(28)}\n\n## 推奨\n\n${"まずは共有ページから始めてください。".repeat(10)}`,
      "doc",
    ],
  ])("%s", (_, text, kind) => {
    expect(deliverableOfferKind(text)).toBe(kind);
  });
});

describe("deliverableOfferAllowed", () => {
  const card = (
    patch: Partial<DeliverableOfferCard>
  ): DeliverableOfferCard => ({
    ...EMPTY_DELIVERABLE_OFFER_CARD,
    ...patch,
  });
  const offer = { id: "m9", threadId: "t1", turn: 5 };

  it.each([
    ["never shown", null, true],
    ["an empty record", card({}), true],
    ["two misses", card({ misses: 2 }), true],
    ["three misses", card({ misses: 3 }), false],
    [
      "two misses and the shown one passed over",
      card({ misses: 2, shownOffer: "m1", answered: null }),
      false,
    ],
    [
      "two misses and the shown one answered",
      card({ misses: 2, shownOffer: "m1", answered: "m1" }),
      true,
    ],
    ["two closes", card({ dismissed: 2 }), false],
    [
      "the reply right after the last offered one",
      card({ shownOffer: "m7", shownThread: "t1", shownTurn: 4 }),
      false,
    ],
    [
      "a turn later",
      card({ shownOffer: "m5", shownThread: "t1", shownTurn: 3 }),
      true,
    ],
    [
      "the next turn of another chat",
      card({ shownOffer: "m7", shownThread: "t2", shownTurn: 4 }),
      true,
    ],
  ])("%s", (_, record, allowed) => {
    expect(deliverableOfferAllowed(record, offer)).toBe(allowed);
  });
});
