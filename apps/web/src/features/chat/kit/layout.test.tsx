/**
 * The chat layout's geometry: the transcript column and the composer column
 * take their clamps from the shell's tokens (`--transcript-max-w`,
 * `--composer-max-w`), the composer a step narrower and both centred.
 */
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SHELL_GEOMETRY } from "#renderer/features/shell/geometry";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay } from "../testing";

let current: Awaited<ReturnType<typeof renderRelay>> | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
});

describe("chat layout widths", () => {
  it("clamps the transcript and the composer with the shell tokens", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      ...b.text("u0", "user", "hello"),
      ...b.text("a0", "assistant", "hi"),
    ]);
    current = await renderRelay(relay, "bot");
    await screen.findByText("hi");
    const content = document.querySelector(
      '[data-slot="message-scroller-content"]'
    )!;
    expect(content.className).toContain("max-w-(--transcript-max-w)");
    expect(content.className).toContain("mx-auto");
    const dock = document.querySelector('[data-slot="composer-dock"]')!;
    expect(dock.className).toContain("max-w-(--composer-max-w)");
    expect(dock.className).toContain("mx-auto");
    expect(SHELL_GEOMETRY.composerMaxW).toBeLessThan(
      SHELL_GEOMETRY.transcriptMaxW
    );
  });
});
