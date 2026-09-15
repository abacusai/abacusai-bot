import { describe, expect, it } from "vitest";

import { localPathFromHref, localPathFromUrl } from "./markdown-local-links";

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

describe("localPathFromHref", () => {
  it("decodes the escaped spaces a markdown link carries in a bare path", () => {
    // The agent wrote `[shot.png](screenshots/Screenshot%202026-09-14.png)`
    // and the preview asked for a file literally named with `%20`.
    expect(
      localPathFromHref(
        "screenshots/Screenshot%202026-09-14%20at%2012.55.59%20AM.png"
      )
    ).toBe("screenshots/Screenshot 2026-09-14 at 12.55.59 AM.png");
    expect(localPathFromHref("/Users/dev/My%20Docs/a.md")).toBe(
      "/Users/dev/My Docs/a.md"
    );
    expect(localPathFromHref("~/Desktop/shot%201.png")).toBe(
      "~/Desktop/shot 1.png"
    );
  });

  it("keeps a name whose % is not an escape", () => {
    expect(localPathFromHref("reports/100%.png")).toBe("reports/100%.png");
  });

  it("leaves web links and fragments alone", () => {
    expect(localPathFromHref("https://example.com/a%20b")).toBeNull();
    expect(localPathFromHref("#section")).toBeNull();
  });

  it("still reads the URL forms", () => {
    expect(localPathFromHref("file:///tmp/My%20File.md")).toBe(
      "/tmp/My File.md"
    );
    expect(localPathFromHref("abacusfile:docs/guide.md")).toBe("docs/guide.md");
  });
});
