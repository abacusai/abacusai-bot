import { describe, expect, it } from "vitest";

import { settingsQueryKeys } from "./settings-query-keys";

describe("settings query keys", () => {
  it("groups related model data under one scope", () => {
    expect(settingsQueryKeys.models.providers.slice(0, 2)).toEqual(
      settingsQueryKeys.models.all
    );
  });

  it("can invalidate all MCP modes or one mode", () => {
    expect(settingsQueryKeys.mcp.servers("code")).toEqual([
      "settings",
      "mcp",
      "servers",
      "code",
    ]);
    expect(settingsQueryKeys.mcp.servers("code").slice(0, 2)).toEqual(
      settingsQueryKeys.mcp.all
    );
  });

  it("separates installed skills by workspace", () => {
    expect(settingsQueryKeys.skills.installed("one")).not.toEqual(
      settingsQueryKeys.skills.installed("two")
    );
  });
});
