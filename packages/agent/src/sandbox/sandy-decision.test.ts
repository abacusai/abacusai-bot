import { beforeEach, describe, expect, it, vi } from "vitest";

import { decide } from "./index.js";
import type { SandboxPolicy } from "./policy.js";
import * as sandy from "./sandy.js";

vi.mock("../sandbox-support.js", () => ({ sandboxBackendFor: () => "sandy" }));
vi.mock("./sandy.js", () => ({ probe: vi.fn(), prepare: vi.fn() }));

const policy: SandboxPolicy = {
  mode: "workspace-write",
  enforcement: "auto",
  workspaceRoot: "C:/workspace",
  writableTemp: [],
  toolHomes: [],
  approvedWrites: [],
  secrets: { denied: [], allowed: [], promptable: [] },
  network: { kind: "open" },
};

describe("Sandy decisions", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(["auto", "strict"] as const)(
    "refuses under %s when the runner fails its probe",
    async (enforcement) => {
      vi.mocked(sandy.probe).mockReturnValue(false);
      expect(
        (
          await decide(
            { ...policy, enforcement },
            "echo test",
            policy.workspaceRoot
          )
        ).kind
      ).toBe("refused");
      expect(sandy.prepare).not.toHaveBeenCalled();
    }
  );

  it("refuses a grant failure without retrying unconfined", async () => {
    vi.mocked(sandy.probe).mockReturnValue(true);
    vi.mocked(sandy.prepare).mockImplementation(() => {
      throw new Error("grant refused");
    });
    const result = await decide(policy, "echo test", policy.workspaceRoot);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused")
      expect(result.message).toContain("grant refused");
  });

  it("keeps Full access independent of Sandy availability", async () => {
    expect(
      await decide(
        { ...policy, enforcement: "off" },
        "echo test",
        policy.workspaceRoot
      )
    ).toEqual({ kind: "unconfined", reason: "mode" });
    expect(sandy.probe).not.toHaveBeenCalled();
  });
});
