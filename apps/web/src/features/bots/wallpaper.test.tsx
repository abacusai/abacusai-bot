/**
 * The chat wallpaper (03-bots §24): off by default; the details panel's
 * picker shows every option as a live thumbnail; a choice round-trips to
 * the bot row and the transcript carries the wallpaper attribute and layer
 * only while one is set; the user bubble turns to glass only then.
 */
import { BOT_WALLPAPER_IDS } from "@abacus-ai/contract/bots";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

// Read from disk: the pipeline passes only tokens.css through `?raw`.
const nodeFs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: "node:fs"): unknown };
  }
).process.getBuiltinModule("node:fs") as {
  readFileSync(path: string, encoding: "utf8"): string;
};
const chatCss = nodeFs.readFileSync(
  `${(import.meta as ImportMeta & { dirname: string }).dirname}/../chat/chat.css`,
  "utf8"
);

let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});

const layout = () =>
  document.querySelector<HTMLElement>('[data-slot="chat-layout"]')!;
const layer = () =>
  layout().querySelector<HTMLElement>('[data-slot="chat-wallpaper"]');

describe("chat wallpaper", () => {
  it("is none by default, offers every option, and round-trips the choice to the row and the transcript", async () => {
    app = await renderApp("/bots/chief-of-staff?tab=details");
    await screen.findByTestId("bot-chat");
    expect(layout().hasAttribute("data-wallpaper")).toBe(false);
    expect(layer()).toBeNull();
    const group = await screen.findByRole("radiogroup", {
      name: "Chat wallpaper",
    });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("data-wallpaper-option"))).toEqual([
      ...BOT_WALLPAPER_IDS,
    ]);
    expect(
      within(group)
        .getByRole("radio", { name: "None" })
        .getAttribute("aria-checked")
    ).toBe("true");
    // Thumbnails are the real layer in a frame.
    for (const radio of radios)
      expect(
        radio.querySelector(
          `[data-slot="chat-wallpaper"][data-wallpaper="${radio.getAttribute("data-wallpaper-option")}"]`
        )
      ).not.toBeNull();

    fireEvent.click(within(group).getByRole("radio", { name: "Dots" }));
    await waitFor(() =>
      expect(app!.db.bots.rows.get("chief-of-staff")?.wallpaper).toBe("dots")
    );
    await waitFor(() => expect(layout().dataset.wallpaper).toBe("dots"));
    expect(layer()?.dataset.wallpaper).toBe("dots");
    expect(
      within(group)
        .getByRole("radio", { name: "Dots" })
        .getAttribute("aria-checked")
    ).toBe("true");

    fireEvent.click(within(group).getByRole("radio", { name: "None" }));
    await waitFor(() =>
      expect(app!.db.bots.rows.get("chief-of-staff")?.wallpaper).toBeNull()
    );
    await waitFor(() =>
      expect(layout().hasAttribute("data-wallpaper")).toBe(false)
    );
    expect(layer()).toBeNull();
  });

  it("paints a static masked layer in the theme's ink and glasses bubbles only on a wallpaper", () => {
    expect(chatCss).toMatch(
      /--chat-wallpaper-ink: color-mix\(in oklab, var\(--foreground\) 6%, transparent\);/
    );
    expect(chatCss).toMatch(
      /\.dark \{\s*--chat-wallpaper-ink: color-mix\(in oklab, var\(--foreground\) 7%, transparent\);/
    );
    expect(chatCss).toMatch(
      /\[data-slot="chat-wallpaper"\] \{\s*position: absolute;\s*inset: 0;\s*pointer-events: none;\s*contain: strict;/
    );
    for (const id of ["doodle", "dots", "grid", "waves"])
      expect(chatCss).toMatch(
        new RegExp(
          `\\[data-slot="chat-wallpaper"\\]\\[data-wallpaper="${id}"\\] \\{ -webkit-mask-image: url\\("data:image/svg\\+xml,`
        )
      );
    expect(chatCss).toMatch(
      /\[data-wallpaper="solid"\] \{ background-color: var\(--chat-wallpaper-solid\); \}/
    );
    // Bubble glass is scoped to a layout with a wallpaper; none leaves it alone.
    expect(chatCss).toMatch(
      /\[data-slot="chat-layout"\]\[data-wallpaper\] \[data-slot="user-bubble"\] \{[^}]*backdrop-filter: blur\(8px\);/
    );
    expect(chatCss).not.toMatch(/^\[data-slot="user-bubble"\]/m);
  });
});
