import assert from "node:assert/strict";
import { parseArgs } from "node:util";

import { connect } from "../../../scripts/cutover/cdp.mjs";

const { values } = parseArgs({ options: { port: { type: "string" } } });
assert(
  values.port,
  "Provide --port for a fixture renderer with its profile menu open"
);
const pages = await fetch(`http://127.0.0.1:${values.port}/json`).then((r) =>
  r.json()
);
const page = pages.find((page) => page.type === "page");
assert(page, "No renderer page");
const cdp = await connect(page.webSocketDebuggerUrl);
try {
  const layout = await cdp.evaluate(`(() => {
    const groups = document.querySelectorAll('[role="menu"] [role="radiogroup"]');
    const group = groups[0];
    const options = [...(group?.querySelectorAll('[role="radio"]') ?? [])];
    return {
      groups: groups.length,
      height: group?.getBoundingClientRect().height,
      options: options.map((option) => {
        const { top, width, height } = option.getBoundingClientRect();
        return { top, width, height, selected: option.getAttribute('aria-checked') === 'true' };
      }),
    };
  })()`);
  assert.equal(layout.groups, 1, "Theme must be one radio group");
  assert.equal(layout.options.length, 3, "Theme must have three segments");
  assert.equal(layout.height, 32, "Theme must occupy one 32px row");
  for (const option of layout.options) {
    assert.equal(
      option.top,
      layout.options[0].top,
      "Segments must share a row"
    );
    assert.equal(option.height, 32);
    assert(option.width > 0);
    assert(
      Math.abs(option.width - layout.options[0].width) < 1,
      "Segments must be equal width"
    );
  }
  assert.equal(layout.options.filter((option) => option.selected).length, 1);
  console.log("Profile theme row layout passed");
} finally {
  cdp.close();
}
