import { expect, it } from "vitest";

import { rendererHistory } from "./renderer-history";

it("keeps desktop navigation in hash history", () => {
  const before = location.href;
  window.history.replaceState(null, "", "/index.html#/settings/general");
  const { history, basepath } = rendererHistory();
  try {
    expect(basepath).toBe("/");
    expect(history.location.pathname).toBe("/settings/general");
    history.push("/settings/models");
    history.flush();
    expect(location.pathname).toBe("/index.html");
    expect(location.hash).toBe("#/settings/models");
  } finally {
    history.destroy();
    window.history.replaceState(null, "", before);
  }
});
