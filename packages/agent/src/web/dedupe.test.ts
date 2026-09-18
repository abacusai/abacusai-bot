/**
 * That there is still only one web search.
 *
 * Two of them used to reach the model at once — this process's `web_search` and
 * the agent-tools server's, prefixed to `agent-tools_web_search` — with nearly
 * the same description and different backends, so the model picked by coin toss
 * and half the time got the dead one. That was settled by filtering one out at
 * the seam; it is now settled at the source, because the server no longer ships
 * a web search to compete with.
 *
 * These pin the shape that leaves behind: nothing about web search is arbitrated
 * any more, and the filter that remains is for `x_search` alone.
 */
import { afterEach, describe, expect, it } from "vitest";

import { isSupersededWebTool } from "../session.js";

const key = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (key == null) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = key;
});

describe("which web tool gives way", () => {
  it("never filters a web search or fetch, in either credential state", () => {
    // The bundled duplicate is gone, so a name like this can now only come from
    // an MCP server the user added themselves. Dropping it would delete a tool
    // they went and configured on purpose.
    for (const name of ["agent-tools_web_search", "agent-tools_web_extract"]) {
      delete process.env.ANTHROPIC_API_KEY;
      expect(isSupersededWebTool({ name })).toBe(false);

      process.env.ANTHROPIC_API_KEY = "sk-test";
      expect(isSupersededWebTool({ name })).toBe(false);
    }
  });

  it("still stands the server's X search down when it cannot answer", () => {
    // The one genuine arbitration left. xAI's Live Search reads X itself, so it
    // wins where its key exists — and gives way to this process where it does not.
    process.env.ANTHROPIC_API_KEY = "sk-test";
    delete process.env.ABACUSAI_BOT_DESKTOP_X_SEARCH;

    expect(isSupersededWebTool({ name: "agent-tools_x_search" })).toBe(true);
  });

  it("leaves unprefixed and unrelated names alone", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    // This process's own tools never arrive through the MCP list, but a filter
    // that matched them would empty the catalog it is meant to be trimming.
    expect(isSupersededWebTool({ name: "web_search" })).toBe(false);
    expect(isSupersededWebTool({ name: "web_fetch" })).toBe(false);
    expect(isSupersededWebTool({ name: "x_search" })).toBe(false);
    expect(
      isSupersededWebTool({ name: "agent-tools_present_deliverable" })
    ).toBe(false);
    expect(isSupersededWebTool({ name: "myserver_search" })).toBe(false);
  });
});
