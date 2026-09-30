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

interface Rejection extends ActivePointer {
  /** The app (foundation) version the candidate failed on. */
  appVersion: string;
  at: number;
}

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
  readonly #rejectedFile = path.join(
    this.experiencesDirectory,
    "rejected.json"
  );
  /** An activation not yet persisted (waiting on the renderer's readiness). */
  #pending: ActivePointer | undefined;
  /** Activation mutations, one at a time. */
  #mutations: Promise<void> = Promise.resolve();
  /** What `active.json` names, in memory, while an activation is pending. */
  #committed:
    | { directory: string; manifest: ExperienceManifest }
    | null
    | undefined;

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

  /**
   * The renderer `active.json` names (the one a relaunch boots): while an
   * activation is pending this is not `rendererVersion`, the candidate's.
   */
  get committedRendererVersion(): string | null {
    const committed =
      this.#pending === undefined ? this.#active : this.#committed;
    return committed?.manifest.rendererVersion ?? null;
  }

  /** The version of an activation not yet committed nor abandoned. */
  get pendingVersion(): string | null {
    return this.#pending?.version ?? null;
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

  /**
   * Makes `candidate` live for this process. With `commit` (the default) its
   * pointer is written at once. Without it (a renderer change, which must
   * first pass the swap's readiness barrier) nothing is persisted until
   * `commitActivation`: a relaunch before that, or after
   * `abandonActivation`, boots the committed experience, never a candidate
   * that was not seen ready (spec 07 review r1 #9).
   *
   * Activations, commits and abandons run one at a time, in call order: a
   * commit's file writes never interleave with a newer activation, so the
   * newer one keeps its rollback state and `active.json` never names an
   * older candidate than memory does.
   */
  activate(
    candidate: InstalledExperience,
    { commit = true }: { commit?: boolean } = {}
  ): Promise<void> {
    return this.#serialize(async () => {
      const { manifest, manifestSha256 } = candidate;

      await this.linkRuntime(candidate.directory);
      const pointer = { manifestSha256, version: manifest.experienceVersion };
      // The first pending activation remembers what is committed.
      if (this.#pending === undefined) this.#committed = this.#active;
      this.#active = { directory: candidate.directory, manifest };
      this.#staged.delete(manifest.experienceVersion);
      this.#pending = pointer;

      if (commit) await this.#commit(manifest.experienceVersion);
    });
  }

  /** The candidate became ready (or nothing had to): persist its pointer. */
  commitActivation(version: string): Promise<void> {
    return this.#serialize(() => this.#commit(version));
  }

  /**
   * The candidate never became ready: this process goes back to the
   * committed experience, the candidate is remembered as rejected (for this
   * app version, for REJECTION_TTL_MS) so the updater does not install it
   * again, and its tree is deleted unless a pointer still names it.
   */
  abandonActivation(version: string): Promise<void> {
    return this.#serialize(() => this.#abandon(version));
  }

  #serialize(task: () => Promise<void>): Promise<void> {
    const run = this.#mutations.then(task, task);
    this.#mutations = run.catch(() => undefined);
    return run;
  }

  async #commit(version: string): Promise<void> {
    const pending = this.#pending;
    if (pending?.version !== version) return;
    const current = await readPointer(this.#activeFile);

    if (current !== undefined && current.version !== version) {
      await writePointer(this.#previousFile, current);
    }

    await writePointer(this.#activeFile, pending);
    this.#pending = undefined;
    this.#committed = undefined;
  }

  async #abandon(version: string): Promise<void> {
    const pending = this.#pending;
    if (pending?.version !== version) return;
    this.#pending = undefined;
    this.#active = this.#committed ?? null;
    this.#committed = undefined;
    const now = Date.now();
    const rejected = (await this.#readRejected()).filter(
      (entry) =>
        !(
          entry.version === pending.version &&
          entry.manifestSha256 === pending.manifestSha256
        )
    );
    rejected.push({ ...pending, appVersion: app.getVersion(), at: now });
    await writeFileAtomic(
      this.#rejectedFile,
      JSON.stringify(rejected.slice(-REJECTED_KEPT)),
      { restrict: true }
    );
    console.warn(
      `[experience] ${version} never became ready; staying on ${this.version ?? "the baseline"}`
    );
    // Its tree is kept only while a pointer names it.
    const kept = new Set(
      [
        this.version,
        (await readPointer(this.#activeFile))?.version,
        (await readPointer(this.#previousFile))?.version,
      ].filter((entry): entry is string => entry != null)
    );
    if (!kept.has(version)) {
      await fs
        .rm(path.join(this.experiencesDirectory, version), {
          force: true,
          recursive: true,
        })
        .catch((error: unknown) => {
          console.error(
            `[experience] removing rejected ${version} failed`,
            error
          );
        });
    }
  }

  /**
   * A candidate a readiness failure rejected on this app version within
   * REJECTION_TTL_MS: a new app version, or time, gives it another chance.
   */
  async isRejected(version: string, manifestSha256: string): Promise<boolean> {
    return (await this.#readRejected()).some(
      (entry) =>
        entry.version === version && entry.manifestSha256 === manifestSha256
    );
  }

  /** The rejections that still apply; stale ones are dropped. */
  async #readRejected(): Promise<Rejection[]> {
    const appVersion = app.getVersion();
    const now = Date.now();
    try {
      const raw: unknown = JSON.parse(
        await fs.readFile(this.#rejectedFile, "utf-8")
      );
      return Array.isArray(raw)
        ? raw.flatMap((entry) => {
            const pointer = parsePointer(entry);
            if (pointer === undefined) return [];
            const { appVersion: rejectedOn, at } = entry as Record<
              string,
              unknown
            >;
            // Entries from before these fields, another app version, or
            // older than the TTL no longer apply.
            return rejectedOn === appVersion &&
              typeof at === "number" &&
              // Either direction: a clock set back does not pin it forever.
              Math.abs(now - at) < REJECTION_TTL_MS
              ? [{ ...pointer, appVersion, at }]
              : [];
          })
        : [];
    } catch {
      return [];
    }
  }
}

/** Rejected candidates remembered (newest kept). */
const REJECTED_KEPT = 20;

/** How long a readiness rejection keeps a candidate out (per app version). */
export const REJECTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
