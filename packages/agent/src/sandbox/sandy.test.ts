import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SandboxPolicy } from "./policy.js";
import { buildConfig, diagnosticDenials } from "./sandy.js";

describe("Sandy grants", () => {
  let root: string;
  let policy: SandboxPolicy;
  beforeEach(() => {
    root = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "sandy-config-"))
    );
    policy = {
      mode: "workspace-write",
      enforcement: "auto",
      workspaceRoot: root,
      writableTemp: [],
      toolHomes: [],
      approvedWrites: [],
      secrets: { denied: [], allowed: [], promptable: [] },
      network: { kind: "open" },
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = () =>
    buildConfig(
      policy,
      root,
      { bin: root, sh: path.join(root, "sh.exe"), overrideApplets: "" },
      root,
      { USERPROFILE: root }
    );

  it("refuses a broad grant containing a protected store", () => {
    policy.secrets.denied = [path.join(root, "credentials")];
    expect(config).toThrow("protecting a credential store");
  });

  it("does not widen a nonexistent file grant to its parent", () => {
    policy.approvedWrites = [path.join(root, "new.txt")];
    expect(config).toThrow("existing parent directory");
  });

  it("refuses a network policy it cannot enforce", () => {
    policy.network = { kind: "filtered" };
    expect(config).toThrow("per-host");
  });

  it("does not mistake arbitrary failures or relative paths for an approval", () => {
    expect(
      diagnosticDenials(
        "can't create relative.txt: Permission denied\ncan't create C:/new.txt: Function not implemented"
      )
    ).toEqual([]);
  });

  it.runIf(process.platform === "win32")(
    "maps new writes to the existing parent shown on the card",
    () => {
      const target = path.join(root, "new.txt");
      expect(
        diagnosticDenials(`sh: can't create '${target}': Permission denied`)
      ).toEqual([{ kind: "write", path: root }]);
      expect(
        diagnosticDenials(
          "sh: can't open 'Z:/read.txt': Permission denied",
          "Z:",
          root
        )
      ).toEqual([{ kind: "read", path: path.join(root, "read.txt") }]);
    }
  );
});
