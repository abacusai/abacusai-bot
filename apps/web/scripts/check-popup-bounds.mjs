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

test(
  "three shared rows and file-tree highlights keep a two-pixel separation",
  { skip: !endpoint },
  async () => {
    const pages = await (await fetch(`${endpoint}/json/list`)).json();
    const cdp = await connect(
      pages.find((page) => page.type === "page").webSocketDebuggerUrl
    );
    try {
      const path = "/__ui?section=item&stress=sidebar&theme=light";
      if (gallery.includes("?path="))
        await cdp.evaluate(
          "window.popupApp.router.navigate({to:'/__ui',search:{section:'item',stress:'sidebar',theme:'light'}})"
        );
      else
        await cdp.send("Page.navigate", {
          url: gallery.replace("{path}", path),
        });
      let rows;
      for (let attempt = 0; attempt < 100; attempt++) {
        rows = await cdp.evaluate(`(()=>{
        const group=document.querySelector('[data-row-states] [data-slot="item-group"]');
        if(!group)return null;
        return {gap:parseFloat(getComputedStyle(group).rowGap),boxes:[...group.children].map(row=>({top:row.getBoundingClientRect().top,bottom:row.getBoundingClientRect().bottom,radius:getComputedStyle(row).borderRadius}))};
      })()`);
        if (rows) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(rows);
      assert.ok(rows.gap >= 2);
      for (let i = 1; i < rows.boxes.length; i++)
        assert.ok(
          rows.boxes[i].top - rows.boxes[i - 1].bottom >= 2,
          JSON.stringify(rows)
        );
      const hover = await cdp.evaluate(
        `(()=>{const row=document.querySelectorAll('[data-row-states] [data-slot="item"]')[1];const box=row.getBoundingClientRect();return {x:box.x+20,y:box.y+10}})()`
      );
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...hover,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
      });
      const colors = await cdp.evaluate(
        `(()=>{const rows=[...document.querySelectorAll('[data-row-states] [data-slot="item"]')]; rows[2].focus();return rows.map(row=>({bg:getComputedStyle(row).backgroundColor,outline:getComputedStyle(row).outlineWidth,radius:getComputedStyle(row).borderRadius}));})()`
      );
      assert.notEqual(
        colors[0].bg,
        colors[1].bg,
        "selection stays distinct from hover"
      );
      assert.equal(colors[2].outline, "2px");
      assert.ok(colors.every((row) => row.radius === "8px"));
      const tree = await cdp.evaluate(`(()=>{
      const root=document.querySelector('[data-row-states] file-tree-container')?.shadowRoot;
      const rows=[...root.querySelectorAll('[data-type="item"]')]; rows[0].click();
      return rows.map(row=>({top:row.getBoundingClientRect().top,bottom:row.getBoundingClientRect().bottom}));
    })()`);
      assert.equal(tree.length, 3);
      for (let i = 1; i < tree.length; i++)
        assert.ok(tree[i].top - tree[i - 1].bottom >= 2, JSON.stringify(tree));
    } finally {
      cdp.close();
    }
  }
);

test(
  "nested menus collide safely and keyboard navigation scrolls long lists",
  { skip: !endpoint },
  async (t) => {
    const pages = await (await fetch(`${endpoint}/json/list`)).json();
    const cdp = await connect(
      pages.find((page) => page.type === "page").webSocketDebuggerUrl
    );
    try {
      for (const width of widths)
        for (const kind of ["dropdown-menu", "context-menu"])
          await t.test(`${kind}, ${width}px`, async () => {
            await cdp.send("Emulation.setDeviceMetricsOverride", {
              width,
              height: 900,
              deviceScaleFactor: 1,
              mobile: false,
            });
            const search = {
              section: kind,
              stress: "bottom-right",
              theme: "light",
            };
            if (gallery.includes("?path=")) {
              await cdp.evaluate(
                `window.popupApp.router.navigate({to:'/__ui',search:${JSON.stringify(search)}})`
              );
              await cdp.evaluate(
                `window.popupApp.router.navigate({to:'/__ui',search:${JSON.stringify({ ...search, open: kind })}})`
              );
            } else
              await cdp.send("Page.navigate", {
                url: gallery.replace(
                  "{path}",
                  `/__ui?${new URLSearchParams({ ...search, open: kind })}`
                ),
              });
            for (let attempt = 0; attempt < 100; attempt++) {
              if (
                await cdp.evaluate(
                  `!!document.querySelector('[data-slot="${kind}-sub-trigger"]')`
                )
              )
                break;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            await new Promise((resolve) => setTimeout(resolve, 150));
            await cdp.evaluate(
              `document.querySelector('[data-slot="${kind}-item"]').focus()`
            );
            await cdp.send("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: "End",
              code: "End",
              windowsVirtualKeyCode: 35,
            });
            await new Promise((resolve) => setTimeout(resolve, 150));
            const scroll = await cdp.evaluate(
              `(()=>{const p=document.querySelector('[data-slot="${kind}-content"]');const r=p.querySelector('[data-highlighted]');const a=p.getBoundingClientRect(),b=r?.getBoundingClientRect();return {scroll:p.scrollTop,visible:!!b&&b.top>=a.top&&b.bottom<=a.bottom};})()`
            );
            assert.ok(
              scroll.scroll > 0 && scroll.visible,
              JSON.stringify(scroll)
            );
            await cdp.evaluate(
              `(()=>{const p=document.querySelector('[data-slot="${kind}-content"]');p.scrollTop=0;const s=p.querySelector('[data-slot="${kind}-sub-trigger"]');s.focus();s.click();})()`
            );
            await new Promise((resolve) => setTimeout(resolve, 300));
            const sub = await cdp.evaluate(
              `(()=>{const p=document.querySelector('[data-slot="${kind}-sub-content"]');if(!p)return null;const r=p.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,gap:parseFloat(getComputedStyle(p).gap),overflow:p.scrollWidth>p.clientWidth+1};})()`
            );
            assert.ok(sub, "submenu opens");
            assert.ok(
              sub.left >= 7 &&
                sub.right <= width - 7 &&
                sub.top >= 7 &&
                sub.bottom <= 893,
              JSON.stringify(sub)
            );
            assert.ok(sub.gap >= 2);
            assert.equal(sub.overflow, false);
          });
    } finally {
      cdp.close();
    }
  }
);
