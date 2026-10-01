import { expect, it } from "vitest";

import { readSourceFiles } from "#renderer/test-support/source-files";
const sessions = readSourceFiles("./**/*.{ts,tsx}", import.meta.dirname);
const components = readSourceFiles(
  "../../components/{terminal,browser-surface,device,diff-view,file-tree}/**/*.{ts,tsx}",
  import.meta.dirname
);
it("R4-T11/R4-T28 session feature and component imports respect ownership", () => {
  for (const [file, source] of Object.entries(sessions)) {
    if (/\.test\.tsx?$/.test(file)) continue;
    expect(source, file).not.toMatch(
      /from\s+["']#renderer\/features\/(?!sessions)/
    );
    expect(source, file).not.toMatch(/\.message\s*(?:\.includes\(|===)/);
    expect(source, file).not.toMatch(
      /(?:from\s+|import\s*\(|require\s*\()["'](?:@xterm\/|[^"']*(?:trellis|monaco))/
    );
    expect(source, file).not.toMatch(/<webview/);
  }
  for (const [file, source] of Object.entries(components)) {
    expect(source, file).not.toMatch(
      /from\s+["']#renderer\/(?:features|data)\//
    );
  }
});
