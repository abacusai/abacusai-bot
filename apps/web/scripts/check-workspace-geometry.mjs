/** Run only against a seeded acceptance profile; mutates its panel/pref state. */
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export function inspectWorkspaceGeometry() {
  const root =
    document.querySelector(
      '[data-slot="session-dock"] [data-slot="panel-workspace"]'
    ) ?? document.querySelector('[data-slot="panel-workspace"]');
  if (!root) throw Error("Workspace not mounted");
  const bounds = (e) => {
    const r = e.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  };
  const expanded = root.hasAttribute("data-workspace-expanded");
  const islands = [
    ...root.querySelectorAll(
      expanded
        ? "[data-workspace-group][data-group-active]"
        : "[data-workspace-pane]"
    ),
  ]
    .filter((e) => {
      const r = bounds(e);
      return r.width > 1 && r.height > 1;
    })
    .map((e) => ({
      id: e.dataset.workspaceGroup ?? e.dataset.workspacePane,
      ...bounds(e),
    }));
  const token = parseFloat(
    getComputedStyle(root).getPropertyValue("--pane-inset")
  );
  const ancestor = [];
  const sourceNodes = [];
  const paths = [
    root,
    ...root.querySelectorAll(
      expanded
        ? "[data-workspace-group][data-group-active]"
        : "[data-workspace-pane]"
    ),
  ];
  for (const start of paths)
    for (
      let e = start === root ? root : start.parentElement;
      e;
      e = e.parentElement
    ) {
      if (sourceNodes.includes(e)) continue;
      sourceNodes.push(e);
      const s = getComputedStyle(e);
      ancestor.push({
        element: e.dataset.slot ?? e.className ?? e.tagName,
        background: s.backgroundColor,
        padding: s.padding,
        margin: s.margin,
        border: s.borderWidth,
        inline: e.getAttribute("style"),
      });
    }

  const lineNodes = [
    ...root.querySelectorAll(
      ".workspace-island, [data-slot=pane], [data-slot=side-panel], [data-pane-gutter], .dv-sash, .dv-groupview"
    ),
  ].filter((e) => bounds(e).width > 1 && bounds(e).height > 1);
  const lines = lineNodes.map((e) => {
    const style = getComputedStyle(e);
    const grip = getComputedStyle(e, "::after");
    const gutter = e.matches("[data-pane-gutter], .dv-sash");
    return {
      element: e.dataset.slot ?? e.className,
      border: style.borderWidth,
      outline: style.outlineStyle,
      shadow: style.boxShadow,
      gutter,
      idle: !e.matches(
        ":hover, :focus-visible, :active, .dv-active, [data-separator=active]"
      ),
      gripOpacity: grip.opacity,
    };
  });
  const layers = [...root.querySelectorAll(".dv-render-overlay")]
    .filter((e) => bounds(e).width > 1)
    .map((e) => ({
      rect: bounds(e),
      padding: getComputedStyle(e).padding,
      inline: e.getAttribute("style"),
    }));
  const gaps = [];
  for (const a of islands)
    for (const b of islands) {
      if (
        b.left >= a.right - 1 &&
        Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1
      )
        gaps.push({ a: a.id, b: b.id, axis: "x", value: b.left - a.right });
      if (
        b.top >= a.bottom - 1 &&
        Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1
      )
        gaps.push({ a: a.id, b: b.id, axis: "y", value: b.top - a.bottom });
    }
  // Only nearest adjacent pairs: a nested island can have another between it and a distant one.
  const adjacent = gaps.filter(
    (g) =>
      !gaps.some(
        (h) => h.a === g.a && h.axis === g.axis && h.value < g.value - 1
      )
  );
  const rect = bounds(root);
  const edges = islands.length
    ? {
        left: Math.min(...islands.map((r) => r.left)) - rect.left,
        right: rect.right - Math.max(...islands.map((r) => r.right)),
        top: Math.min(...islands.map((r) => r.top)) - rect.top,
        bottom: rect.bottom - Math.max(...islands.map((r) => r.bottom)),
      }
    : {};
  const sources = [];
  const rules = (list, source) => {
    for (const rule of list) {
      if (rule.cssRules?.length) {
        if (
          !rule.conditionText ||
          !rule.media ||
          matchMedia(rule.conditionText).matches
        )
          rules(rule.cssRules, source);
        continue;
      }
      if (!rule.selectorText || !rule.style) continue;
      const relevant = [
        "padding",
        "padding-inline",
        "padding-block",
        "margin",
        "border-width",
        "border",
        "outline",
        "box-shadow",
        "opacity",
        "background",
        "background-color",
      ].filter((p) => rule.style.getPropertyValue(p));
      if (!relevant.length) continue;
      try {
        if (
          [...sourceNodes, ...lineNodes].some((e) =>
            e.matches(rule.selectorText.replace(/::(?:before|after)/g, ""))
          ) ||
          [...root.querySelectorAll(".dv-render-overlay")].some((e) =>
            e.matches(rule.selectorText)
          )
        )
          sources.push({
            source,
            selector: rule.selectorText,
            css: relevant
              .map((p) => p + ":" + rule.style.getPropertyValue(p))
              .join(";"),
          });
      } catch {}
    }
  };
  for (const sheet of document.styleSheets)
    try {
      rules(
        sheet.cssRules,
        sheet.ownerNode?.dataset?.viteDevId?.split("/apps/web/")[1] ??
          sheet.href ??
          "inline"
      );
    } catch {}
  return {
    token,
    material:
      ["darwin", "win32"].includes(document.documentElement.dataset.platform) &&
      document.documentElement.dataset.titlebar === "overlay" &&
      document.documentElement.dataset.translucency !== "off" &&
      document.documentElement.dataset.windowFocused !== "false" &&
      !matchMedia("(prefers-reduced-transparency: reduce)").matches,
    effectiveExpanded: expanded,
    rect,
    islands,
    gaps: adjacent,
    edges,
    ancestor,
    layers,
    lines,
    sources,
    primary: document.querySelector('[data-slot="sidebar-slot"]')?.dataset.mode,
    peek: !!document.querySelector('[data-slot="sidebar-floating"]'),
    rows: document.querySelector('[data-slot="topbar-panel-tabs"]')?.dataset
      .railMode,
  };
}
export function geometryFailures(record) {
  const failures = [];
  for (const [edge, value] of Object.entries(record.edges))
    if (Math.abs(value) > 1)
      failures.push(
        `outer ${edge}: ${value}px (expected 0; shell owns the inset)`
      );
  for (const gap of record.gaps)
    if (Math.abs(gap.value - record.token) > 1)
      failures.push(
        `${gap.a}/${gap.b} ${gap.axis}: ${gap.value}px (expected ${record.token}px)`
      );
  for (const ancestor of record.ancestor ?? [])
    for (const property of ["padding", "margin"])
      for (const value of ancestor[property].split(" ").map(parseFloat))
        if (value && Math.abs(value - record.token) > 1)
          failures.push(
            `${ancestor.element} ${property}: ${value}px (not a shared inset)`
          );
  if (record.material !== false)
    for (const ancestor of record.ancestor ?? [])
      if (
        ancestor.background &&
        !["transparent", "rgba(0, 0, 0, 0)"].includes(ancestor.background)
      )
        failures.push(
          `${ancestor.element} paints ${ancestor.background} over native material`
        );
  for (const line of record.lines ?? []) {
    if (
      line.border.split(" ").some((v) => parseFloat(v) !== 0) ||
      !["none", "hidden"].includes(line.outline) ||
      line.shadow !== "none"
    )
      failures.push(`${line.element} draws a permanent island/gutter line`);
    if (line.gutter && line.idle && Number(line.gripOpacity) !== 0)
      failures.push(`${line.element} shows its grip while idle`);
  }
  return failures;
}
async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "9558" },
      session: { type: "string" },
      workspace: { type: "string" },
      bot: { type: "string" },
      out: { type: "string", default: "/tmp/workspace-geometry.json" },
      quick: { type: "boolean", default: false },
    },
  });
  if (!values.session || !values.workspace || !values.bot)
    throw Error(
      "Provide --session --workspace --bot from a seeded temp profile."
    );
  const pages = await fetch(`http://127.0.0.1:${values.port}/json`).then((r) =>
    r.json()
  );
  const page = pages.find(
    (p) => p.type === "page" && p.url.includes("index.html")
  );
  if (!page) throw Error("No desktop renderer");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) =>
    ws.addEventListener("open", resolve, { once: true })
  );
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const r = JSON.parse(data);
    if (r.id) {
      const p = pending.get(r.id);
      pending.delete(r.id);
      if (r.error) p.reject(r.error);
      else p.resolve(r.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const run = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw Error(
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text
      );
    return r.result.value;
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const sessionKey = JSON.stringify([
    "conversation",
    1,
    values.workspace,
    "session",
    values.session,
  ]);
  const records = [];
  try {
    await run(
      `if(!window.__abacusDev)throw Error('VITE_UI_GALLERY acceptance build required')`
    );
    for (const width of values.quick
      ? [800, 1280]
      : [640, 800, 1000, 1280, 1710, 2560]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      console.log(`Checking ${width}px…`);
      for (const area of ["sessions", "bots"])
        for (const primary of values.quick
          ? ["collapsed"]
          : ["pinned", "collapsed", "peek"])
          for (const count of values.quick ? [6] : [1, 6, 12])
            for (const twoRows of [false, true]) {
              await run(`__abacusDev.setPinned(${primary === "pinned"})`);
              await run(
                `__abacusDev.call('db.prefs.update',{patch:{appearance:{allowTwoTabRows:${twoRows}}}})`
              );
              for (const secondary of ["closed", "docked", "floating"])
                for (const expanded of [false, true]) {
                  const scope =
                    area === "sessions" ? sessionKey : "bots:" + values.bot;
                  if (area === "sessions")
                    await run(
                      `import('/src/features/sessions/dock/panel-tabs-store.ts').then(m=>m.updateTabs(${JSON.stringify(sessionKey)},s=>({...s,open:${secondary !== "closed"},tabs:Array.from({length:${Math.max(0, count - 1)}},(_,i)=>({ref:'preview:geometry-'+i,title:'Geometry '+i+'.ts',path:'sample.ts',openedAt:i})),order:[]})))`
                    );
                  else
                    await run(
                      `import('/src/lib/side-panel/store.ts').then(m=>{m.panelStore.setState(s=>({...s,[${JSON.stringify(scope)}]:{open:${secondary !== "closed"},expanded:${expanded},active:${count > 1 ? "'files:geometry-0'" : "null"},tabs:Array.from({length:${Math.max(0, count - 1)}},(_,i)=>({id:'files:geometry-'+i,kind:'files',title:'Geometry '+i+'.ts',path:'sample.ts'}))}}))})`
                    );
                  await run(
                    `__abacusDev.navigate(${JSON.stringify("/" + area + "/" + (area === "sessions" ? values.session : values.bot) + (area === "sessions" ? "?view=" + (expanded ? "full" : "split") + (secondary !== "closed" && count > 1 ? "&tab=preview:geometry-0" : "") : ""))})`
                  );
                  await wait(80);
                  await run(
                    `import('/src/features/shell/shell-store.ts').then(m=>{${primary === "peek" ? "m.openFloating('peek')" : "m.closeFloating()"}})`
                  );
                  for (const layout of expanded &&
                  secondary !== "closed" &&
                  count > 1
                    ? ["single", "horizontal", "vertical", "nested"]
                    : ["single"]) {
                    await run(
                      `__abacusDev.workspaceLayout(${JSON.stringify(scope)},${JSON.stringify(layout)})`
                    );
                    await run(
                      "new Promise(resolve => {let previous=null,stable=0,frames=0;const tick=()=>{const root=document.querySelector('[data-slot=panel-workspace]');const r=root?.getBoundingClientRect();const next=r ? [r.width,r.height] : [0,0];stable=previous&&next.every((v,i)=>Math.abs(v-previous[i])<0.1)?stable+1:0;previous=next;if(stable>=5||++frames>=90)resolve();else requestAnimationFrame(tick)};requestAnimationFrame(tick)})"
                    );
                    const geometry = await run(
                      `(${inspectWorkspaceGeometry.toString()})()`
                    );
                    const cell = {
                      width,
                      area,
                      primary,
                      secondary,
                      expanded,
                      chatTab: expanded,
                      count,
                      twoRows,
                      layout,
                      ...geometry,
                    };
                    cell.failures = geometryFailures(cell);
                    records.push(cell);
                    if (cell.failures.length)
                      console.log(
                        JSON.stringify({
                          width,
                          area,
                          primary,
                          secondary,
                          expanded,
                          count,
                          twoRows,
                          layout,
                          failures: cell.failures,
                          sources: cell.sources,
                        })
                      );
                  }
                }
            }
    }
  } finally {
    await send("Emulation.clearDeviceMetricsOverride");
    await writeFile(values.out, JSON.stringify(records, null, 2));
    ws.close();
  }
  const failed = records.filter((r) => r.failures.length);
  console.log(
    `${records.length} cells, ${failed.length} failed. ${values.out}`
  );
  if (failed.length) process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
