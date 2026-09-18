import { describe, expect, it } from "vitest";

import { sandboxBackendFor } from "./sandbox-support.js";

describe("sandbox backend selection", () => {
  it.each(["10.0.19045", "10.0.22631", "10.0.26100", "10.0.26200"])(
    "disables sandboxing on Windows %s",
    (release) => {
      expect(sandboxBackendFor("win32", release)).toBeNull();
    }
  );

  it.each(["darwin", "linux"] as const)(
    "keeps the sandbox runtime on %s",
    (platform) => {
      expect(sandboxBackendFor(platform, "")).toBe("sandbox-runtime");
    }
  );
});
