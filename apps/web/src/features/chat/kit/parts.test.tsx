import { v1ToUiMessages } from "@abacus-ai/contract/transcript/v1-to-ui-messages";
/**
 * R2-T11 (spec 02 §5.3): the exported `SessionUI`/`BotUI` configurations
 * over live and C.3-migrated history (the real `v1ToUiMessages` mapper):
 * every `metadata.abacus.kind`, image, video, credits footer; user text
 * helpers (reminders stripped, routine fires hidden, attachment chips); an
 * empty assistant message renders nothing (F12).
 */
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay } from "../testing";

const V1 = import.meta.glob<{ segments: unknown[] }>(
  "../../../../../../packages/contract/src/transcript/__fixtures__/v1/*.json",
  { import: "default", eager: true }
);
const fixture = (name: string) =>
  v1ToUiMessages(
    V1[
      `../../../../../../packages/contract/src/transcript/__fixtures__/v1/${name}.json`
    ]!.segments
  );

let current: Awaited<ReturnType<typeof renderRelay>> | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
});

const migrated = async (name: string, skin: "bot" | "session" = "session") => {
  current = await renderRelay(new FakeRelay({ history: fixture(name) }), skin);
};

describe("R2-T11 parts", () => {
  it("compaction: a separator with the summary", async () => {
    await migrated("compaction");
    expect(
      await screen.findByText("Earlier conversation summarised")
    ).toBeTruthy();
    expect(screen.getByText("Continuing from the summary.")).toBeTruthy();
  });

  it("notifications render as notice rows", async () => {
    await migrated("notification");
    expect(
      await screen.findByText("You are out of premium credits.")
    ).toBeTruthy();
    expect(
      document.querySelectorAll('[data-slot="notice"]').length
    ).toBeGreaterThanOrEqual(2);
  });

  it("image and video media", async () => {
    await migrated("media");
    await screen.findByText("Draw a cat, then animate it");
    expect(document.querySelector("img")).toBeTruthy();
    expect(document.querySelector("video")).toBeTruthy();
  });

  it("credits footers", async () => {
    await migrated("credits");
    expect(
      (await screen.findAllByText(/Used \d+ credits?/)).length
    ).toBeGreaterThan(0);
  });

  it("thinking, collapsible and feature limit", async () => {
    await migrated("display-segments");
    await screen.findByText("Done.");
    expect(screen.getByText("Thoughts")).toBeTruthy();
    expect(document.querySelector('[data-slot="feature-limit"]')).toBeTruthy();
  });

  it.each(["session", "bot"] as const)(
    "tool groups have a summary and the %s default expansion",
    async (skin) => {
      await migrated("tool-group", skin);
      if (skin === "bot") {
        expect(screen.queryByText(/Worked through/)).toBeNull();
        expect(
          screen.queryByRole("button", {
            name: "Read 2 files, searched 1 pattern",
          })
        ).toBeNull();
        expect(document.querySelectorAll("[data-tool]")).toHaveLength(0);
        return;
      }
      const summary = await screen.findByRole("button", {
        name: "Read 2 files, searched 1 pattern",
      });
      expect(summary.getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelectorAll("[data-tool]")).toHaveLength(3);
    }
  );

  it.each(["session", "bot"] as const)(
    "%s renders web search and unknown migrated parts",
    async (skin) => {
      await migrated("display-segments", skin);
      expect(await screen.findByText("Done.")).toBeTruthy();
      expect(
        document.querySelector('[data-slot="feature-limit"]')
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: /Top up|Upgrade/ })
      ).toBeNull();
    }
  );

  it.each(["session", "bot"] as const)(
    "%s renders migrated search results and preserves unknown data",
    async (skin) => {
      await migrated("web-search", skin);
      expect(
        document.querySelectorAll('[data-slot="search-results"]')
      ).toHaveLength(skin === "session" ? 2 : 0);
      const links = document.querySelectorAll(
        '[data-slot="search-results"] button'
      );
      expect(links.length > 0).toBe(skin === "session");
      await current!.cleanup();
      current = null;
      await migrated("unknown-segments", skin);
      if (skin === "session")
        expect(
          (await screen.findAllByText("[unknown]")).length
        ).toBeGreaterThan(0);
      else expect(screen.queryByText("[unknown]")).toBeNull();
    }
  );

  it.each(["session", "bot"] as const)(
    "%s handles a document part through the default kit map",
    async (skin) => {
      current = await renderRelay(
        new FakeRelay({
          history: [
            {
              id: "doc",
              role: "assistant",
              parts: [
                {
                  type: "document",
                  source: {
                    type: "url",
                    value: "https://example.com/report.pdf",
                  },
                },
              ],
            },
          ],
        }),
        skin
      );
      if (skin === "session")
        expect(await screen.findByText(/report.pdf|document/i)).toBeTruthy();
      else expect(screen.queryByText(/report.pdf|document/i)).toBeNull();
    }
  );

  it("live: reminders stripped, routine fires hidden, attachments as chips, empty assistant renders nothing", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.text(
        "u1",
        "user",
        "hello<system_reminder>secret</system_reminder>\n\n@/tmp/report.pdf"
      ),
      ...b.text("a1", "assistant", ""),
      b.runError("r1", { message: "Boom" }),
      b.runStarted("r2"),
      ...b.text("u2", "user", '[routine] "Daily digest" fired'),
      b.runFinished("r2"),
    ]);
    current = await renderRelay(relay, "session");
    expect(await screen.findByText("hello")).toBeTruthy();
    expect(screen.queryByText(/secret/)).toBeNull();
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.queryByText(/Daily digest/)).toBeNull();
    expect(
      document.querySelector('[data-message-id="a1"] [data-role]')
    ).toBeNull();
    expect(screen.getByText("Boom")).toBeTruthy();
  });
});

it("clusters consecutive tools while dropping blank prose wrappers", async () => {
  const relay = new FakeRelay();
  relay.emitAll([
    ...b.sessionReady(),
    b.runStarted("density"),
    b.textStart("calls"),
    b.textDelta("calls", "  "),
    ...b.toolCall("c1", "bash", "calls", { command: "npm test" }),
    b.toolResult("c1", { text: "ok" }),
    ...b.toolCall("c2", "bash", "calls", { command: "npm run lint" }),
    b.toolResult("c2", { text: "ok" }),
    ...b.toolCall("c3", "read", "calls", { path: "/tmp/example.txt" }),
    b.toolResult("c3", { text: "example" }),
    b.textEnd("calls"),
  ]);
  current = await renderRelay(relay, "session");
  await screen.findByText("Run npm test");
  const clusters = document.querySelectorAll('[data-slot="tool-cluster"]');
  expect(clusters).toHaveLength(2);
  expect(clusters[0]!.querySelectorAll("[data-tool]")).toHaveLength(2);
  expect(clusters[1]!.querySelectorAll("[data-tool]")).toHaveLength(1);
  expect(
    document.querySelectorAll('[data-role="assistant"] > div')
  ).toHaveLength(2);
  expect(
    document.querySelector('[data-slot="session-message-actions"]')
  ).toBeNull();
});
