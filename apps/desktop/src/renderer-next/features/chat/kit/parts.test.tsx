/**
 * R2-T11 (spec 02 §5.3): the exported `SessionUI`/`BotUI` configurations
 * over live and C.3-migrated history (the real `v1ToUiMessages` mapper):
 * every `metadata.abacus.kind`, image, video, credits footer; user text
 * helpers (reminders stripped, routine fires hidden, attachment chips); an
 * empty assistant message renders nothing (F12).
 */
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { v1ToUiMessages } from "#shared/transcript/v1-to-ui-messages";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay } from "../testing";

const V1 = import.meta.glob<{ segments: unknown[] }>(
  "../../../../shared/transcript/__fixtures__/v1/*.json",
  { import: "default", eager: true }
);
const fixture = (name: string) => v1ToUiMessages(V1[`../../../../shared/transcript/__fixtures__/v1/${name}.json`]!.segments);

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
    expect(await screen.findByText("Earlier conversation summarised")).toBeTruthy();
    expect(screen.getByText("Continuing from the summary.")).toBeTruthy();
  });

  it("notifications render as notice rows", async () => {
    await migrated("notification");
    expect(await screen.findByText("You are out of premium credits.")).toBeTruthy();
    expect(document.querySelectorAll('[data-slot="notice"]').length).toBeGreaterThanOrEqual(2);
  });

  it("image and video media", async () => {
    await migrated("media");
    await screen.findByText("Draw a cat, then animate it");
    expect(document.querySelector("img")).toBeTruthy();
    expect(document.querySelector("video")).toBeTruthy();
  });

  it("credits footers", async () => {
    await migrated("credits");
    expect((await screen.findAllByText(/Used \d+ credits?/)).length).toBeGreaterThan(0);
  });

  it("thinking, collapsible and feature limit", async () => {
    await migrated("display-segments");
    await screen.findByText("Done.");
    expect(screen.getByText("Thoughts")).toBeTruthy();
    expect(document.querySelector('[data-slot="feature-limit"]')).toBeTruthy();
  });

  it("live: reminders stripped, routine fires hidden, attachments as chips, empty assistant renders nothing", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.text("u1", "user", "hello<system_reminder>secret</system_reminder>\n\n@/tmp/report.pdf"),
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
    expect(document.querySelector('[data-message-id="a1"] [data-role]')).toBeNull();
    expect(screen.getByText("Boom")).toBeTruthy();
  });
});
