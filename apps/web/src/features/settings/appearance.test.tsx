/** The Appearance page: gallery previews, controls writing prefs, import. */
import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import enUS from "#locales/en-US.json";
import { STOCK, THEMES, themeTokens } from "#renderer/lib/look";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";

const copy = enUS.settings.appearance;
const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});
const look = () => app!.db.prefs.rows.get("app")?.appearance;
const row = (id: string) =>
  within(document.querySelector<HTMLElement>(`[data-setting-id="${id}"]`)!);

it("renders a live mini-app preview per theme from its own tokens", async () => {
  app = await renderApp("/settings/appearance");
  const gallery = await screen.findByRole("radiogroup", {
    name: enUS.settings.theme.label,
  });
  const cards = within(gallery).getAllByRole("radio");
  expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(
    THEMES.map((theme) => theme.name)
  );
  expect(
    within(gallery)
      .getByRole("radio", { name: "Default" })
      .getAttribute("aria-checked")
  ).toBe("true");
  const preview = (name: string) =>
    within(gallery)
      .getByRole("radio", { name })
      .querySelector<HTMLElement>('[data-slot="theme-preview"]')!;
  // Light OS: each card paints its own light background, scoped to the card.
  expect(preview("Paper").style.getPropertyValue("--background")).toBe(
    THEMES.find((theme) => theme.id === "paper")!.light!.bg
  );
  // Midnight has no light variant, so its card shows the dark one.
  expect(preview("Midnight").style.getPropertyValue("--background")).toBe(
    "#000000"
  );
  expect(preview("Slate").style.getPropertyValue("--th-keyword")).toMatch(
    /^#[\da-f]{6}$/
  );
  // Default's card paints the stock values the stylesheets apply.
  const stock = preview("Default").style;
  expect(stock.getPropertyValue("--background")).toBe(STOCK.light.background);
  expect(stock.getPropertyValue("--chat-user-bubble")).toBe(
    STOCK.light["chat-user-bubble"]
  );
  expect(stock.getPropertyValue("--ring")).toBe(
    themeTokens(THEMES[0]!, "light", { high: false, accent: "default" }).ring
  );
  expect(document.documentElement.style.getPropertyValue("--background")).toBe(
    ""
  );
});

it("moves through the gallery and the accents with arrow keys, one tab stop each", async () => {
  app = await renderApp("/settings/appearance");
  const gallery = await screen.findByRole("radiogroup", {
    name: enUS.settings.theme.label,
  });
  const cards = within(gallery).getAllByRole("radio");
  expect(cards.map((card) => card.tabIndex)).toEqual(
    cards.map((_, i) => (i === 0 ? 0 : -1))
  );
  fireEvent.keyDown(cards[0]!, { key: "ArrowRight" });
  await waitFor(() => expect(look()?.palette).toBe("paper"));
  expect(document.activeElement).toBe(cards[1]);
  fireEvent.keyDown(cards[1]!, { key: "End" });
  await waitFor(() => expect(look()?.palette).toBe("midnight"));
  fireEvent.keyDown(cards.at(-1)!, { key: "ArrowRight" });
  await waitFor(() => expect(look()?.palette).toBe("default"));

  const accents = within(
    screen.getByRole("radiogroup", { name: copy.accent })
  ).getAllByRole("radio");
  expect(
    accents.map(
      (radio) => radio.getAttribute("aria-label") ?? radio.textContent
    )
  ).toEqual([
    copy.colors.abacusai,
    copy.themeAccent,
    copy.colors.neutral,
    ...Object.entries(copy.colors)
      .filter(([name]) => name !== "abacusai" && name !== "neutral")
      .map(([, name]) => name),
  ]);
  fireEvent.keyDown(accents[1]!, { key: "End" });
  await waitFor(() => expect(look()?.accent).toBe("#12838f"));
});

it("picking a theme, an accent, contrast and fonts writes prefs and re-themes the app", async () => {
  app = await renderApp("/settings/appearance");
  fireEvent.click(await screen.findByRole("radio", { name: "Grove" }));
  await waitFor(() => expect(look()?.palette).toBe("grove"));
  await waitFor(() =>
    expect(document.documentElement.dataset.palette).toBe("grove")
  );
  expect(
    screen.getByRole("radio", { name: "Grove" }).getAttribute("aria-checked")
  ).toBe("true");

  fireEvent.click(screen.getByRole("radio", { name: copy.colors.pink }));
  await waitFor(() => expect(look()?.accent).toBe("#d6457a"));
  await waitFor(() =>
    expect(
      document.documentElement.style.getPropertyValue("--accent-text")
    ).not.toBe("")
  );
  fireEvent.click(row("accent").getByRole("radio", { name: copy.themeAccent }));
  await waitFor(() => expect(look()?.accent).toBe("default"));
  fireEvent.click(
    row("accent").getByRole("radio", { name: copy.colors.neutral })
  );
  await waitFor(() => expect(look()?.accent).toBeNull());

  fireEvent.click(row("contrast").getByRole("button", { name: copy.high }));
  await waitFor(() => expect(look()?.contrast).toBe("high"));
  await waitFor(() =>
    expect(document.documentElement.dataset.contrast).toBe("high")
  );

  fireEvent.click(row("radius").getByRole("button", { name: copy.round }));
  await waitFor(() => expect(look()?.radius).toBe("round"));

  const font = row("codeFont").getByRole("combobox");
  fireEvent.change(font, { target: { value: "Menlo" } });
  fireEvent.blur(font);
  await waitFor(() => expect(look()?.codeFont).toBe("Menlo"));
  fireEvent.click(row("codeSize").getByRole("button", { name: "14" }));
  await waitFor(() => expect(look()?.codeFontSize).toBe(14));
  await waitFor(() =>
    expect(
      document.documentElement.style.getPropertyValue("--code-font-size")
    ).toBe("14px")
  );

  fireEvent.click(row("theme").getByRole("button", { name: "Dark" }));
  await waitFor(() =>
    expect(app!.db.prefs.rows.get("app")?.theme).toBe("dark")
  );
});

it("imports a pasted VS Code theme as a selected custom card, and removes it", async () => {
  app = await renderApp("/settings/appearance");
  fireEvent.click(await screen.findByRole("button", { name: copy.pasteLabel }));
  const area = await screen.findByRole("textbox", { name: copy.pasteLabel });
  fireEvent.change(area, { target: { value: "{ nope" } });
  fireEvent.click(screen.getByRole("button", { name: copy.import }));
  expect((await screen.findByRole("alert")).textContent).toBe(copy.notATheme);

  fireEvent.change(area, {
    target: {
      value:
        '{"name": "Harbor", "type": "dark", "colors": {"editor.background": "#1b1f27", "focusBorder": "#5aa2ff",}}',
    },
  });
  fireEvent.click(screen.getByRole("button", { name: copy.import }));
  await waitFor(() => expect(look()?.palette).toBe("custom"));
  expect(look()?.custom).toMatchObject({
    name: "Harbor",
    dark: { bg: "#1b1f27", accent: "#5aa2ff" },
  });
  expect(screen.queryByRole("alert")).toBeNull();
  const card = await screen.findByRole("radio", { name: "Harbor" });
  expect(card.getAttribute("aria-checked")).toBe("true");
  // Dark only: the page says so, and the app is forced dark.
  expect(row("palette").getByText(copy.forcedDark)).toBeDefined();
  await waitFor(() =>
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  );

  fireEvent.click(
    row("importTheme").getByRole("button", { name: copy.remove })
  );
  await waitFor(() =>
    expect(look()).toMatchObject({ custom: null, palette: "default" })
  );
});

it("opens one theme file through main's dialog on Electron", async () => {
  const seed = defaultSeed();
  const kinds: unknown[] = [];
  let big = false;
  app = await renderApp("/settings/appearance", {
    seed,
    procedures: {
      system: {
        dialog: {
          openFiles: os.system.dialog.openFiles.handler(({ input }) => {
            kinds.push(input?.kind);
            return big
              ? [
                  {
                    path: "/t/huge.json",
                    name: "huge.json",
                    mimeType: "application/json",
                    data: new Uint8Array(0),
                    size: 3 * 1024 * 1024,
                  },
                ]
              : [
                  {
                    path: "/t/sunrise.json",
                    name: "sunrise.json",
                    mimeType: "application/json",
                    // This realm's Uint8Array, so the RPC serializer sends it as bytes.
                    data: new Uint8Array(
                      new TextEncoder().encode(
                        '{"colors": {"editor.background": "#fdf6e3"}}'
                      )
                    ),
                  },
                ];
          }),
        },
      },
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: copy.openFile }));
  await waitFor(() =>
    expect(look()?.custom).toEqual({
      name: "sunrise",
      light: { bg: "#fdf6e3" },
    })
  );
  expect(kinds).toEqual(["theme"]);
  big = true;
  fireEvent.click(screen.getByRole("button", { name: copy.openFile }));
  expect((await screen.findByRole("alert")).textContent).toBe(copy.tooLarge);
  expect(look()?.custom?.name).toBe("sunrise");
});

it("hints when a pasted theme is mostly an include", async () => {
  app = await renderApp("/settings/appearance");
  fireEvent.click(await screen.findByRole("button", { name: copy.pasteLabel }));
  fireEvent.change(
    await screen.findByRole("textbox", { name: copy.pasteLabel }),
    {
      target: {
        value:
          '{"include": "./base.json", "colors": {"editor.background": "#202020"}}',
      },
    }
  );
  fireEvent.click(screen.getByRole("button", { name: copy.import }));
  expect((await screen.findByText(copy.includeHint)).getAttribute("role")).toBe(
    "status"
  );
  await waitFor(() => expect(look()?.palette).toBe("custom"));
});

it("offers window translucency on the desktop app on macOS", async () => {
  app = await renderApp("/settings/appearance");
  const toggle = await screen.findByRole("switch", { name: copy.translucency });
  fireEvent.click(toggle);
  await waitFor(() => expect(look()?.translucency).toBe(false));
  await waitFor(() =>
    expect(document.documentElement.dataset.translucency).toBe("off")
  );
});

it("offers the icons-only rail, off by default, and writes the pref", async () => {
  app = await renderApp("/settings/appearance");
  const toggle = await screen.findByRole("switch", {
    name: copy.railIconsOnly,
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  await waitFor(() => expect(look()?.railIconsOnly).toBe(true));
  await waitFor(() =>
    expect(
      document
        .querySelector('[data-slot="rail"]')
        ?.getAttribute("data-icons-only")
    ).toBe("")
  );
});

it("labels every option of every control with copy, never a key", async () => {
  app = await renderApp("/settings/appearance");
  await screen.findByRole("radiogroup", { name: enUS.settings.theme.label });
  const main = document.querySelector("main")!;
  // Controls named by their row (aria-labelledby) are covered by the row
  // titles; font suggestions (datalist) are font names, not copy.
  const named = [
    ...main.querySelectorAll<HTMLElement>(
      'button:not([aria-labelledby]), [role="radio"], select option, [id$="-label"], [id$="-detail"]'
    ),
  ];
  expect(named.length).toBeGreaterThan(30);
  for (const element of named) {
    const label =
      element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
    expect(label, element.outerHTML.slice(0, 120)).not.toBe("");
    expect(label).not.toMatch(/^[a-z][\w-]*(\.[\w-]+)+$/);
  }
  const contrast = within(
    document.querySelector<HTMLElement>('[data-setting-id="contrast"]')!
  );
  expect(contrast.getByRole("button", { name: copy.system }).textContent).toBe(
    "System"
  );
});

it("keeps a single tab row by default and persists opting into two rows", async () => {
  app = await renderApp("/settings/appearance");
  const toggle = await screen.findByRole("switch", {
    name: copy.allowTwoTabRows,
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(app!.collections.prefs.get("app")?.appearance?.allowTwoTabRows).toBe(
      true
    )
  );
});
