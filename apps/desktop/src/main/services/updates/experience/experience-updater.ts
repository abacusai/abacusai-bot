/**
 * Relaunchless updater for the experience release unit (renderer and agent
 * bundles): poll a TUF repository, extract under strict limits, re-verify the
 * tree, health-check the candidate agent, install, activate. New sessions
 * spawn from the new bundle at once; the window swaps renderers between turns
 * (renderer-host.ts). Foundation changes ship as signed installers through
 * electron-updater, never this path.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { app } from "electron";
import extract from "extract-zip";
import { Updater } from "tuf-js";

import { resourcePath } from "#main/resources";

import type { ExperienceStore } from "./experience-store";
import { checkAgentBundle } from "./health-check";
import { verifyExperience } from "./integrity";

const TARGET = "experience/latest.zip";
const MAX_FILES = 10_000;
const MAX_UNCOMPRESSED_SIZE = 300 * 1024 * 1024;

/** Beside the foundation's electron-updater feeds on the same CDN prefix. */
const PRODUCTION_UPDATE_URL =
  "https://downloads.abacus.ai/abacusai-bot/experience/";

export interface ExperienceUpdaterDeps {
  /** Called after activation whenever the renderer bundle changed. */
  onRendererChanged: (version: string) => void;
  store: ExperienceStore;
}

interface UpdateEnvironment {
  interval: number;
  root: string | undefined;
  url: string | undefined;
}

const readEnvironment = (): UpdateEnvironment => {
  const interval = Number(process.env.ABACUSAI_BOT_UPDATE_INTERVAL_MS);

  return {
    interval:
      Number.isFinite(interval) && interval > 0
        ? interval
        : app.isPackaged
          ? 15 * 60_000
          : 5000,
    // Packaged builds ignore the env overrides: TUF still verifies signatures,
    // but a shell profile line must not redirect the source or swap the root.
    root: app.isPackaged
      ? undefined
      : process.env.ABACUSAI_BOT_UPDATE_ROOT?.trim() || undefined,
    url: app.isPackaged
      ? PRODUCTION_UPDATE_URL
      : // Development only updates when pointed at a repository explicitly.
        process.env.ABACUSAI_BOT_UPDATE_URL?.trim() || undefined,
  };
};

const exists = async (file: string): Promise<boolean> => {
  try {
    await fs.access(file);

    return true;
  } catch {
    return false;
  }
};

export class ExperienceUpdater {
  #checking: Promise<void> | undefined;
  #target: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #warnedNoRoot = false;
  readonly #deps: ExperienceUpdaterDeps;
  readonly #environment = readEnvironment();

  constructor(deps: ExperienceUpdaterDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#environment.url === undefined || this.#timer !== undefined) {
      return;
    }

    const check = (): void => {
      this.#checking ??= this.#runCheck();
      void this.#checking.catch((error: unknown) => {
        console.error("[experience] update check failed", error);
      });
    };

    check();
    this.#timer = setInterval(check, this.#environment.interval);
    this.#timer.unref();
  }

  dispose(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async #runCheck(): Promise<void> {
    try {
      this.#target = await this.#check();
    } finally {
      this.#checking = undefined;
    }
  }

  async #check(): Promise<string | undefined> {
    const base = this.#environment.url;

    if (base === undefined) return undefined;

    const { store } = this.#deps;
    // The root ships through the extraResources copy, never the asar.
    const root = this.#environment.root ?? resourcePath("update-root.json");

    if (!(await exists(root))) {
      // No trusted root means no experience channel.
      if (!this.#warnedNoRoot) {
        this.#warnedNoRoot = true;
        console.warn("[experience] updates disabled: no trusted root at", root);
      }

      return undefined;
    }

    const cache = path.join(store.experiencesDirectory, ".tuf");
    const metadata = path.join(cache, "metadata");
    const targets = path.join(cache, "targets");

    await fs.mkdir(metadata, { recursive: true });
    await fs.mkdir(targets, { recursive: true });
    const trustedRoot = path.join(metadata, "root.json");

    // The cached root persists in-band TUF rotations, but when the shipped
    // anchor itself changes (a dev machine moving between roots) the cache is
    // trust in the wrong chain and every check fails unsigned. Reset it then.
    const rootBytes = await fs.readFile(root);
    const rootDigest = createHash("sha256").update(rootBytes).digest("hex");
    const seedFile = path.join(cache, "root-seed.sha256");
    const seeded = await fs.readFile(seedFile, "utf-8").catch(() => "");

    if (seeded.trim() !== rootDigest) {
      await fs.rm(metadata, { force: true, recursive: true });
      await fs.rm(targets, { force: true, recursive: true });
      await fs.mkdir(metadata, { recursive: true });
      await fs.mkdir(targets, { recursive: true });
      await fs.writeFile(seedFile, `${rootDigest}\n`);

      if (seeded !== "") {
        console.log("[experience] trusted root changed; trust cache reset");
      }
    }

    if (!(await exists(trustedRoot))) {
      await fs.copyFile(root, trustedRoot);
    }

    const updater = new Updater({
      config: {
        fetchRetries: 2,
        fetchTimeout: 10_000,
        userAgent: `AbacusAIBot/${app.getVersion()}`,
      },
      metadataBaseUrl: new URL("metadata/", base).href,
      metadataDir: metadata,
      targetBaseUrl: new URL("targets/", base).href,
      targetDir: targets,
    });

    await updater.refresh();
    const target = await updater.getTargetInfo(TARGET);

    if (target === undefined) return undefined;

    const targetHash = target.hashes.sha256;

    if (targetHash === this.#target) return this.#target;

    const archive =
      (await updater.findCachedTarget(target)) ??
      (await updater.downloadTarget(target));
    const temporary = await fs.mkdtemp(
      path.join(store.experiencesDirectory, ".candidate-")
    );

    try {
      let files = 0;
      let size = 0;

      await extract(archive, {
        dir: temporary,
        onEntry: (entry) => {
          files += 1;
          size += entry.uncompressedSize;
          const mode =
            Math.floor(entry.externalFileAttributes / 65_536) % 65_536;

          if (
            files > MAX_FILES ||
            size > MAX_UNCOMPRESSED_SIZE ||
            Math.floor(mode / 4096) === 10
          ) {
            throw new Error("Experience archive exceeds its extraction policy");
          }
        },
      });
      // TUF verified the archive; this re-verifies the extracted tree against
      // the manifest, whose protocol/foundationApi literals gate compatibility.
      const manifest = await verifyExperience(temporary, app.getVersion());

      if (manifest.experienceVersion === store.version) {
        return targetHash;
      }

      // The candidate's agent resolves native imports through the linked
      // runtime, so the link must exist before the health check.
      await store.linkRuntime(temporary);
      await checkAgentBundle(temporary);

      const installed = path.join(
        store.experiencesDirectory,
        manifest.experienceVersion
      );
      const manifestSha256 = createHash("sha256")
        .update(await fs.readFile(path.join(temporary, "manifest.json")))
        .digest("hex");

      if (await exists(installed)) {
        try {
          await verifyExperience(installed, app.getVersion(), manifestSha256);
        } catch {
          await fs.rm(installed, { force: true, recursive: true });
          await fs.rename(temporary, installed);
        }
      } else {
        await fs.rename(temporary, installed);
      }

      const rendererChanged =
        manifest.rendererVersion !== store.rendererVersion;
      const candidate = store.install(manifest, manifestSha256);

      await store.activate(candidate);
      console.log(`[experience] activated ${manifest.experienceVersion}`);

      if (rendererChanged) {
        this.#deps.onRendererChanged(manifest.experienceVersion);
      }

      return targetHash;
    } finally {
      await fs.rm(temporary, { force: true, recursive: true });
    }
  }
}
