/**
 * Install → serve → register, end to end with a stand-in downloader: the
 * model lands under the home directory, the endpoint comes up, config.json
 * gains the `local` provider the agent reads, and removal takes it away.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalModelProgress } from "#shared/local-models";
import { LOCAL_MODEL_CATALOG } from "#shared/local-models";

const resources = vi.hoisted(() => ({ root: "" }));

vi.mock("../../resources", () => ({
  resourcePath: (...segments: string[]) =>
    path.join(resources.root, ...segments),
}));

const { LocalModelService } = await import("./local-model-service");
const { modelPath } = await import("./model-store");

const spec = LOCAL_MODEL_CATALOG[0]!;
let home: string;
let progress: LocalModelProgress[];
let providerChanges: number;
/** What the stand-in downloader does: write the file, or fail, or hang until aborted. */
let downloader: "write" | "fail" | "hang";

const fakeDownload: typeof import("./model-store").downloadModel = async (
  target,
  { onProgress, signal }
) => {
  onProgress(0, target.sizeBytes);
  if (downloader === "fail") throw new Error("the network went away");
  if (downloader === "hang") {
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")))
    );
  }
  onProgress(target.sizeBytes, target.sizeBytes);
  fs.mkdirSync(path.dirname(modelPath(target)), { recursive: true });
  // The size is what "installed" is read from; the bytes are not read here.
  fs.writeFileSync(modelPath(target), "");
  fs.truncateSync(modelPath(target), target.sizeBytes);
  return modelPath(target);
};

const config = (): {
  customProviders?: Array<{
    id: string;
    baseUrl: string;
    apiKey?: string;
    models: Array<{ id: string }>;
  }>;
} => JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));

const service = () =>
  new LocalModelService({
    onProgress: (p) => progress.push(p),
    onProviderChanged: () => {
      providerChanges += 1;
    },
    totalMemoryBytes: () => 8 * 1024 ** 3,
    download: fakeDownload,
  });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "local-models-"));
  process.env.ABACUSAI_BOT_HOME = home;
  resources.root = fs.mkdtempSync(path.join(os.tmpdir(), "llama-res-"));
  const binary = path.join(
    resources.root,
    "vendor",
    "llama",
    process.platform === "win32" ? "llama-server.exe" : "llama-server"
  );
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
  progress = [];
  providerChanges = 0;
  downloader = "write";
});

afterEach(() => {
  delete process.env.ABACUSAI_BOT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(resources.root, { recursive: true, force: true });
});

describe("LocalModelService", () => {
  it("reports what the machine can do before anything is installed", async () => {
    const local = service();
    await local.start();
    const state = local.state();

    expect(state.runtimeAvailable).toBe(true);
    expect(state.recommendedId).toBe("qwen3.5-4b");
    expect(state.installedIds).toEqual([]);
    expect(state.download).toBeNull();
    expect(state.servingId).toBeNull();
    // Nothing installed: no endpoint, no provider entry, nothing announced.
    expect(fs.existsSync(path.join(home, "config.json"))).toBe(false);
    expect(providerChanges).toBe(0);
    local.dispose();
  });

  it("installs a model, brings the endpoint up and registers the provider", async () => {
    const local = service();
    await local.start();

    const outcome = await local.install(spec.id);

    expect(outcome).toEqual({ ok: true, model: `local/${spec.id}` });
    expect(local.state().installedIds).toEqual([spec.id]);
    expect(progress.map((p) => p.phase)).toEqual([
      "downloading",
      "verifying",
      "ready",
    ]);
    expect(progress.at(-1)?.receivedBytes).toBe(spec.sizeBytes);

    const provider = config().customProviders?.find(
      (entry) => entry.id === "local"
    );
    expect(provider?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    // Without a key the agent reads the model as unconfigured and answers on
    // a different one; the endpoint itself checks nothing.
    expect(provider?.apiKey).toBeTruthy();
    expect(provider?.models.map((model) => model.id)).toEqual([spec.id]);
    expect(providerChanges).toBeGreaterThan(0);
    local.dispose();
  });

  it("says what went wrong, and leaves nothing registered", async () => {
    downloader = "fail";
    const local = service();

    const outcome = await local.install(spec.id);

    expect(outcome).toEqual({ ok: false, error: "the network went away" });
    expect(progress.at(-1)).toMatchObject({
      phase: "failed",
      error: "the network went away",
    });
    expect(local.state().installedIds).toEqual([]);
    expect(local.state().download).toBeNull();
    local.dispose();
  });

  it("can be cancelled, and refuses a second download while one runs", async () => {
    downloader = "hang";
    const local = service();

    const first = local.install(spec.id);
    await vi.waitFor(() =>
      expect(local.state().download?.phase).toBe("downloading")
    );
    expect(await local.install(spec.id)).toEqual({
      ok: false,
      error: "a download is already running",
    });

    local.cancelInstall();
    expect(await first).toEqual({ ok: false, error: "cancelled" });
    expect(progress.at(-1)?.phase).toBe("cancelled");
    local.dispose();
  });

  it("refuses an unknown model and a build without the runtime", async () => {
    const local = service();
    expect(await local.install("nope")).toEqual({
      ok: false,
      error: "unknown model nope",
    });

    fs.rmSync(path.join(resources.root, "vendor"), {
      recursive: true,
      force: true,
    });
    expect(local.state().runtimeAvailable).toBe(false);
    expect((await local.install(spec.id)).ok).toBe(false);
    local.dispose();
  });

  it("removes a model and, with it gone, the provider entry", async () => {
    const local = service();
    await local.start();
    await local.install(spec.id);

    local.remove(spec.id);

    expect(local.state().installedIds).toEqual([]);
    expect(fs.existsSync(modelPath(spec))).toBe(false);
    expect(config().customProviders).toBeUndefined();
    local.dispose();
  });
});
