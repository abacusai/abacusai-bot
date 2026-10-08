import assert from "node:assert/strict";
import { test } from "node:test";

import { connect } from "../../../scripts/cutover/cdp.mjs";

const endpoint = process.env.POPUP_CDP_URL;
const gallery =
  process.env.POPUP_GALLERY_URL ?? "http://127.0.0.1:5199/bot{path}";
const widths = [320, 640, 900, 1280, 1710];
const kinds = [
  "dropdown-menu",
  "context-menu",
  "popover",
  "select",
  "combobox",
  "command",
  "hover-card",
  "tooltip",
];
const edges = [
  "sidebar",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

test(
  "popup bounds and row overflow at narrow sizes and viewport edges",
  { skip: !endpoint },
  async (t) => {
    const pages = await (await fetch(`${endpoint}/json/list`)).json();
    const cdp = await connect(
      pages.find((page) => page.type === "page").webSocketDebuggerUrl
    );
    try {
      await cdp.send("Page.setBypassCSP", { enabled: true });
      const fixture = gallery.includes("?path=");
      if (fixture) {
        await cdp.send("Page.navigate", {
          url: gallery.replace("{path}", encodeURIComponent("/sessions/new")),
        });
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await cdp.evaluate("!!window.popupApp")) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      for (const width of widths)
        for (const kind of kinds)
          for (const edge of edges) {
            await t.test(`${kind}, ${width}px, ${edge}`, async () => {
              await cdp.send("Emulation.setDeviceMetricsOverride", {
                width,
                height: 900,
                deviceScaleFactor: 1,
                mobile: false,
              });
              const path = `/__ui?section=${kind}&open=${kind}&stress=${edge}&theme=light`;
              if (fixture) {
                await cdp.evaluate(
                  `window.popupApp.router.navigate({to:'/__ui',search:${JSON.stringify({ section: kind, stress: edge, theme: "light" })}})`
                );
                await cdp.evaluate(
                  `window.popupApp.router.navigate({to:'/__ui',search:${JSON.stringify({ section: kind, open: kind, stress: edge, theme: "light" })}})`
                );
              } else {
                await cdp.send("Page.navigate", {
                  url: gallery.replace("{path}", path),
                });
              }
              let result;
              for (let attempt = 0; attempt < 100; attempt++) {
                result = await cdp.evaluate(`(() => {
            const popup = document.querySelector('[data-slot="${kind === "command" ? "dialog" : kind}-content"]');
            if (document.readyState !== "complete" || !popup || !popup.getBoundingClientRect().height) return null;
            const box = popup.getBoundingClientRect();
            const rows = [...popup.querySelectorAll('[role="menuitem"], [role="option"], [cmdk-item]')];
            return {left:box.left, right:box.right, top:box.top, bottom:box.bottom,
              width:innerWidth, height:innerHeight, overflow:rows.filter(row=>row.scrollWidth > row.clientWidth + 1).map(row=>row.textContent)};
          })()`);
                if (result) break;
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
              assert.ok(result, "popup opens");
              // Let the positioner finish sizing and shifting after its first layout.
              await new Promise((resolve) => setTimeout(resolve, 120));
              result = await cdp.evaluate(`(() => {
          const popup=document.querySelector('[data-slot="${kind === "command" ? "dialog" : kind}-content"]');
          const box=popup.getBoundingClientRect();
          return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,
            overflow:[...popup.querySelectorAll('[role="menuitem"], [role="option"], [cmdk-item]')].filter(row=>row.scrollWidth>row.clientWidth+1).map(row=>row.textContent)};
        })()`);
              assert.ok(
                result.left >= 7 &&
                  result.top >= 7 &&
                  result.right <= width - 7 &&
                  result.bottom <= 893,
                JSON.stringify(result)
              );
              assert.deepEqual(
                result.overflow,
                [],
                "rows never overflow horizontally"
              );
            });
          }
    } finally {
      cdp.close();
    }
  }
);
