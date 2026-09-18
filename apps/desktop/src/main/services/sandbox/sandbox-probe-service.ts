import { execFile } from "node:child_process";
import os from "node:os";

import { sandboxBackendFor } from "@abacus-ai/agent/sandbox-support";

import type { SandboxSupport } from "#shared/contracts";

import type { ResolvedAgentArtifact } from "../session/artifact-resolver-service";

/**
 * Whether this machine can confine a shell command, asked once. Auto is
 * offered only where the answer is yes: a machine with no working sandbox
 * gets Full access alone rather than an Auto that runs everything unconfined.
 *
 * The agent process answers (`--sandbox-probe`), since the runtime that
 * knows is bundled beside it and cannot load inside the asar. The answer is
 * kept for the life of the app; installing bubblewrap mid-run is a relaunch.
 */
export class SandboxProbeService {
  private probe: Promise<SandboxSupport> | null = null;

  constructor(
    private readonly resolveArtifact: () => ResolvedAgentArtifact,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly release: string = os.release()
  ) {}

  support(): Promise<SandboxSupport> {
    this.probe ??= this.run().catch((error: unknown) => ({
      available: false,
      reason: `the sandbox probe failed: ${error instanceof Error ? error.message : String(error)}`,
    }));

    return this.probe;
  }

  private async run(): Promise<SandboxSupport> {
    // No backend at all is known without spawning anything.
    if (sandboxBackendFor(this.platform, this.release) === null) {
      return {
        available: false,
        reason:
          this.platform === "win32"
            ? "sandboxing is disabled on Windows"
            : `no sandbox backend for ${this.platform}`,
      };
    }

    const artifact = this.resolveArtifact();

    return new Promise((resolve, reject) => {
      execFile(
        artifact.execPath,
        [...artifact.execArgs, "--sandbox-probe"],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          timeout: 30_000,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error != null) {
            reject(error);
            return;
          }
          resolve(parseProbe(stdout));
        }
      );
    });
  }
}

/** The last JSON line: the runtime may print warnings before it. */
export function parseProbe(stdout: string): SandboxSupport {
  const lines = stdout.trim().split("\n");
  const parsed: unknown = JSON.parse(lines[lines.length - 1] ?? "");

  if (
    parsed == null ||
    typeof parsed !== "object" ||
    typeof (parsed as { active?: unknown }).active !== "boolean"
  ) {
    throw new Error("the probe printed no verdict");
  }
  const { active, reason } = parsed as { active: boolean; reason?: unknown };

  return {
    available: active,
    reason: typeof reason === "string" ? reason : null,
  };
}
