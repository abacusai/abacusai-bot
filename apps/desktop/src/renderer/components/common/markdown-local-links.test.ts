import { describe, expect, it } from "vitest";

import { localPathFromUrl } from "./markdown-local-links";

describe("localPathFromUrl", () => {
  it("decodes file URLs", () => {
    expect(localPathFromUrl("file:///tmp/My%20File.md")).toBe(
      "/tmp/My File.md"
    );
  });

  it("decodes links saved by the previous renderer", () => {
    expect(localPathFromUrl("abacusfile:docs/guide.md")).toBe("docs/guide.md");
    expect(localPathFromUrl("abacusfile:///C:/work/app.ts")).toBe(
      "C:/work/app.ts"
    );
  });

  it("leaves web links to the remote-link handler", () => {
    expect(localPathFromUrl("https://example.com/docs")).toBeNull();
  });
});
