import fs from "fs";
import path from "path";

import { agentEntry } from "#main/resources";
import { experienceAgentEntry } from "#main/services/updates/experience/active-experience";

/**
 * Locates the agent bundle the app spawns per session. It is plain JavaScript
 * run on Electron's bundled Node via `ELECTRON_RUN_AS_NODE`, shipped beside
 * the asar because a script inside app.asar cannot be spawned.
 */
export type ResolvedAgentArtifact = {
  /** Executable to spawn — Electron's binary, run in pure-Node mode. */
  execPath: string;
  /** Arguments that precede the agent's own flags (the entry script). */
  execArgs: string[];
  /** Directory the agent entry lives in, for diagnostics. */
  agentRoot: string;
};

export class ArtifactResolverService {
  resolveBundledCliPath(): ResolvedAgentArtifact {
    // An installed experience supersedes the baseline bundle for new sessions;
    // running sessions keep the process they started with.
    const entry = experienceAgentEntry() ?? agentEntry();

    try {
      fs.accessSync(entry, fs.constants.R_OK);
    } catch {
      // An unbuilt agent would otherwise surface as every send failing quietly.
      throw new Error(
        `AbacusAI Bot agent entry not found at ${entry}. Run "pnpm build" first.`
      );
    }

    return {
      execPath: process.execPath,
      execArgs: [entry],
      agentRoot: path.dirname(entry),
    };
  }
}
