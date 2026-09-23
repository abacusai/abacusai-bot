import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resources = vi.hoisted(() => ({ root: "" }));

vi.mock("../../resources", () => ({
  resourcePath: (...segments: string[]) =>
    path.join(resources.root, ...segments),
}));

const { llamaServerArgs, llamaServerAvailable, llamaServerBinary } =
  await import("./llama-server");

beforeEach(() => {
  resources.root = fs.mkdtempSync(path.join(os.tmpdir(), "llama-res-"));
});

afterEach(() => {
  fs.rmSync(resources.root, { recursive: true, force: true });
});

describe("the bundled server", () => {
  it("is looked for under the app's vendored resources", () => {
    expect(llamaServerBinary()).toBe(
      path.join(
        resources.root,
        "vendor",
        "llama",
        process.platform === "win32" ? "llama-server.exe" : "llama-server"
      )
    );
    expect(llamaServerAvailable()).toBe(false);

    fs.mkdirSync(path.dirname(llamaServerBinary()), { recursive: true });
    fs.writeFileSync(llamaServerBinary(), "#!/bin/sh\n", { mode: 0o755 });
    expect(llamaServerAvailable()).toBe(true);
  });

  it("is started for one model, one slot, tools on and thinking off", () => {
    const args = llamaServerArgs("/models/x.gguf", "x", 4242);

    expect(args.slice(0, 2)).toEqual(["--model", "/models/x.gguf"]);
    expect(args).toContain("--alias");
    expect(args[args.indexOf("--alias") + 1]).toBe("x");
    expect(args[args.indexOf("--port") + 1]).toBe("4242");
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1");
    expect(args[args.indexOf("--parallel") + 1]).toBe("1");
    expect(args[args.indexOf("--ctx-size") + 1]).toBe("32768");
    expect(args).toContain("--jinja");
    expect(args[args.indexOf("--chat-template-kwargs") + 1]).toBe(
      '{"enable_thinking":false}'
    );
    // Never "none": that leaves the template's empty think block in the
    // reply, and the transcript shows the tags.
    expect(args[args.indexOf("--reasoning-format") + 1]).toBe("deepseek");
    expect(args).toContain("--no-webui");
  });
});
