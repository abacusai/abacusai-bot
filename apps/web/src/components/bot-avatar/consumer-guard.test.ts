import { expect, it } from "vitest";

import { readSourceFiles } from "#renderer/test-support/source-files";

it("keeps bot rendering behind the live rig and rejects raster morph names", () => {
  const sources = readSourceFiles(
    ["../../features/**/*.{tsx,css}"],
    import.meta.dirname
  );
  for (const [name, source] of Object.entries(sources)) {
    if (name.includes(".test.")) continue;
    expect(source, name).not.toMatch(
      /viewTransitionName:\s*["'`]bot-identity|useSharedElementName\(botIdentityName|shared:\s*`bot-identity/
    );
    expect(source, name).not.toMatch(
      /<img[^>]+(?:bot-avatar|avatars\/|avatarShape)/
    );
    expect(source, name).not.toMatch(
      /import[^;]+from\s*["'][^"']*(?:legacy-avatar|old-avatar|avatar-svg)["']/
    );
  }
});
