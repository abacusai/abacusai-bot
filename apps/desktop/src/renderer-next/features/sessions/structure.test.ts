import { expect, it } from "vitest";
const sessions = import.meta.glob<string>("./**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
});
const components = import.meta.glob<string>(
  "../../components/{terminal,browser-surface,device,diff-view,file-tree}/**/*.{ts,tsx}",
  { eager: true, query: "?raw", import: "default" }
);
it("R4-T11/R4-T28 session feature and component imports respect ownership", () => {
  for (const [file, source] of Object.entries(sessions)) {
    if (file.endsWith(".test.ts")) continue;
    expect(source, file).not.toMatch(
      /from\s+["']#next\/features\/(?!sessions)/
    );
    expect(source, file).not.toMatch(/\.message\s*(?:\.includes\(|===)/);
    expect(source, file).not.toMatch(
      /(?:from\s+|import\s*\(|require\s*\()["'](?:@xterm\/|[^"']*(?:trellis|monaco))/
    );
    expect(source, file).not.toMatch(/<webview/);
  }
  for (const [file, source] of Object.entries(components)) {
    expect(source, file).not.toMatch(/from\s+["']#next\/(?:features|data)\//);
  }
});
