import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SandboxPolicy } from "./policy.js";
import { buildConfig, diagnosticDenials, toolPaths } from "./sandy.js";

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

  it("discovers tool installations from PATH without naming runtimes", () => {
    const tools = path.join(root, "custom-tools");
    fs.mkdirSync(tools);
    expect(toolPaths({ PATH: tools, USERPROFILE: root }, policy)).toEqual([
      tools,
    ]);
  });

  it("does not expose a protected store or the home directory through PATH", () => {
    const tools = path.join(root, "private-tools");
    fs.mkdirSync(tools);
    policy.secrets.denied = [path.join(tools, "credentials")];
    expect(
      toolPaths(
        { PATH: [root, tools].join(path.delimiter), USERPROFILE: root },
        policy
      )
    ).toEqual([]);
  });

  it("allows approved readable tool installations to execute", () => {
    const tools = path.join(root, "approved-tools");
    fs.mkdirSync(tools);
    policy.workspaceRoot = path.join(root, "workspace");
    fs.mkdirSync(policy.workspaceRoot);
    policy.approvedReads = [tools];
    const result = buildConfig(
      policy,
      policy.workspaceRoot,
      { bin: policy.workspaceRoot, sh: "sh.exe", overrideApplets: "" },
      policy.workspaceRoot,
      { USERPROFILE: root }
    );
    expect(result).toContain(`execute = ${JSON.stringify([tools])}`);
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
