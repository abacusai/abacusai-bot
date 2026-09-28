/**
 * Which experience is live. The packaged baseline (asar renderer, agent under
 * `resources/agent/`) is always valid; this store only overlays it with
 * `userData/experiences/<version>/` behind atomic `active.json` /
 * `previous.json` pointers. On startup the first pointer whose tree verifies
 * wins (that order is the rollback); when neither does, the pointers are
 * cleared and the baseline runs as the recovery experience.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "@abacus-ai/agent/atomic-file";
import { app } from "electron";

import { resourcePath } from "#main/resources";

import { verifyExperience } from "./integrity";
import type { ExperienceManifest } from "./integrity";

interface ActivePointer {
  manifestSha256: string;
  version: string;
}

export interface InstalledExperience {
  readonly directory: string;
  readonly manifest: ExperienceManifest;
  readonly manifestSha256: string;
}

const DIGEST = /^[\da-f]{64}$/u;

const parsePointer = (raw: unknown): ActivePointer | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;

  const { manifestSha256, version } = raw as Record<string, unknown>;

  return typeof manifestSha256 === "string" &&
    DIGEST.test(manifestSha256) &&
    typeof version === "string" &&
    DIGEST.test(version)
    ? { manifestSha256, version }
    : undefined;
};

const writePointer = async (
  file: string,
  value: ActivePointer
): Promise<void> => {
  await writeFileAtomic(file, JSON.stringify(value), { restrict: true });
};

const readPointer = async (
  file: string
): Promise<ActivePointer | undefined> => {
  let data: string;

  try {
    data = await fs.readFile(file, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  try {
    const pointer = parsePointer(JSON.parse(data));

    if (pointer !== undefined) return pointer;
  } catch {
    // Fall through to the shared error path below.
  }

  console.error(`[experience] ignoring an invalid pointer at ${file}`);

  return undefined;
};

export class ExperienceStore {
  /** Active installed experience; null means the packaged baseline. */
  #active: { directory: string; manifest: ExperienceManifest } | null = null;
  #initialization: Promise<void> | undefined;
  readonly #staged = new Map<string, InstalledExperience>();

  readonly experiencesDirectory = path.join(
    app.getPath("userData"),
    "experiences"
  );

  /**
   * Native imports resolve here: the foundation's copies beside the baseline
   * agent when packaged, the repository's hoisted node_modules otherwise.
   */
  readonly runtimeModulesDirectory = app.isPackaged
    ? resourcePath("agent", "node_modules")
    : path.resolve(app.getAppPath(), "..", "..", "node_modules");

  readonly #activeFile = path.join(this.experiencesDirectory, "active.json");
  readonly #previousFile = path.join(
    this.experiencesDirectory,
    "previous.json"
  );

  async initialize(): Promise<void> {
    this.#initialization ??= this.#initialize();
    await this.#initialization;
  }

  async #initialize(): Promise<void> {
    const candidates = [
      await readPointer(this.#activeFile),
      await readPointer(this.#previousFile),
    ];

    for (const pointer of candidates) {
      if (pointer === undefined) continue;

      const directory = path.join(this.experiencesDirectory, pointer.version);

      try {
        // Candidate order defines active-to-previous rollback.
        const manifest = await verifyExperience(
          directory,
          app.getVersion(),
          pointer.manifestSha256
        );

        if (manifest.experienceVersion === pointer.version) {
          await this.linkRuntime(directory);
          this.#active = { directory, manifest };
          await writePointer(this.#activeFile, pointer);

          return;
        }
      } catch (error) {
        console.error(
          "[experience] an installed experience is invalid; falling back",
          error
        );
      }
    }

    // Neither pointer verifies: run the baseline and clear the pointers so the
    // next verified install starts a clean chain.
    await fs.rm(this.#activeFile, { force: true });
    await fs.rm(this.#previousFile, { force: true });
    this.#active = null;
  }

  /**
   * Link the foundation's native packages so the agent bundle resolves its
   * external imports; also run on a candidate before its health check.
   */
  async linkRuntime(directory: string): Promise<void> {
    const link = path.join(directory, "node_modules");

    try {
      const existing = await fs.readlink(link);

      if (existing === this.runtimeModulesDirectory) return;

      await fs.rm(link, { force: true, recursive: true });
    } catch {
      // Nothing linked yet.
    }

    await fs.symlink(
      this.runtimeModulesDirectory,
      link,
      process.platform === "win32" ? "junction" : "dir"
    );
  }

  get version(): string | null {
    return this.#active?.manifest.experienceVersion ?? null;
  }

  get rendererVersion(): string | null {
    return this.#active?.manifest.rendererVersion ?? null;
  }

  get agentVersion(): string | null {
    return this.#active?.manifest.agentVersion ?? null;
  }

  get agentDirectory(): string | null {
    return this.#active === null
      ? null
      : path.join(this.#active.directory, "agent");
  }

  get rendererDirectory(): string | null {
    return this.#active === null
      ? null
      : path.join(this.#active.directory, "renderer");
  }

  /** Renderer tree for an app:// hostname. Active or staged versions only. */
  rendererDirectoryFor(version: string): string | undefined {
    if (version !== "" && version === this.version) {
      return this.rendererDirectory ?? undefined;
    }

    const staged = this.#staged.get(version);

    return staged === undefined
      ? undefined
      : path.join(staged.directory, "renderer");
  }

  install(
    manifest: ExperienceManifest,
    manifestSha256: string
  ): InstalledExperience {
    const installed = {
      directory: path.join(
        this.experiencesDirectory,
        manifest.experienceVersion
      ),
      manifest,
      manifestSha256,
    };

    this.#staged.set(manifest.experienceVersion, installed);

    return installed;
  }

  async activate(candidate: InstalledExperience): Promise<void> {
    const { manifest, manifestSha256 } = candidate;

    await this.linkRuntime(candidate.directory);
    const current = await readPointer(this.#activeFile);

    if (current !== undefined) {
      await writePointer(this.#previousFile, current);
    }

    await writePointer(this.#activeFile, {
      manifestSha256,
      version: manifest.experienceVersion,
    });
    this.#active = { directory: candidate.directory, manifest };
    this.#staged.delete(manifest.experienceVersion);
  }
}
