/**
 * Node runtime resolution: how ArtifactResolverService locates the agent
 * binary and entry script.
 *
 * The agent always runs on Electron's own binary (`process.execPath`) with
 * `ELECTRON_RUN_AS_NODE=1`. There is no PATH-based Node lookup. These tests
 * pin that contract and the error path when the entry script is missing.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArtifactResolverService } from "./artifact-resolver-service";

// ---------------------------------------------------------------------------
// Mocks — control what agentEntry() and experienceAgentEntry() return
// without touching production code.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  agentEntry: vi.fn<() => string>(),
  experienceAgentEntry: vi.fn<() => string | null>(),
}));

vi.mock("#main/resources", () => ({
  agentEntry: mocks.agentEntry,
}));
vi.mock("#main/services/updates/experience/active-experience", () => ({
  experienceAgentEntry: mocks.experienceAgentEntry,
}));

let tmpDir: string;
let fakeEntry: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-resolver-"));
  fakeEntry = path.join(tmpDir, "main.js");
  // Default: no experience override, agent entry exists.
  mocks.experienceAgentEntry.mockReturnValue(null);
  mocks.agentEntry.mockReturnValue(fakeEntry);
  fs.writeFileSync(fakeEntry, "// agent entry\n");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("ArtifactResolverService — Node runtime resolution", () => {
  it("returns process.execPath as the executable", () => {
    const resolver = new ArtifactResolverService();
    const result = resolver.resolveBundledCliPath();

    expect(result.execPath).toBe(process.execPath);
  });

  it("returns the agent entry script as the first exec argument", () => {
    const resolver = new ArtifactResolverService();
    const result = resolver.resolveBundledCliPath();

    expect(result.execArgs).toEqual([fakeEntry]);
  });

  it("sets agentRoot to the directory containing the entry script", () => {
    const resolver = new ArtifactResolverService();
    const result = resolver.resolveBundledCliPath();

    expect(result.agentRoot).toBe(path.dirname(fakeEntry));
  });

  it("throws when the agent entry script does not exist", () => {
    // Point at a file that does not exist.
    const missing = path.join(tmpDir, "does-not-exist.js");
    mocks.agentEntry.mockReturnValue(missing);

    const resolver = new ArtifactResolverService();

    expect(() => resolver.resolveBundledCliPath()).toThrow(
      /agent entry not found/i
    );
  });

  it("includes the missing path in the error message", () => {
    const missing = path.join(tmpDir, "vanished.js");
    mocks.agentEntry.mockReturnValue(missing);

    const resolver = new ArtifactResolverService();

    expect(() => resolver.resolveBundledCliPath()).toThrow(missing);
  });
});
