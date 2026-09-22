/**
 * Local models end to end: what this machine can run, downloading one,
 * serving the installed ones through the loopback proxy, and telling the
 * agent about them as a custom provider — `local`, in config.json, the same
 * entry a user would write by hand for their own llama.cpp.
 */
import os from "node:os";

import {
  LOCAL_MODEL_CATALOG,
  LOCAL_MODEL_CONTEXT,
  LOCAL_PROVIDER_ID,
  localModelSpec,
  recommendLocalModel,
  type LocalModelProgress,
  type LocalModelSpec,
  type LocalModelState,
} from "#shared/local-models";

import { removeCustomProvider, upsertCustomProvider } from "../config/settings";
import { LlamaServer, llamaServerAvailable } from "./llama-server";
import { LocalModelProxy } from "./local-model-proxy";
import {
  downloadModel,
  installedModels,
  modelPath,
  removeModel,
} from "./model-store";

export interface LocalModelServiceOptions {
  /** Progress, as it happens, for the renderer. */
  onProgress: (progress: LocalModelProgress) => void;
  /** The provider entry changed: the catalog and the running agents re-read it. */
  onProviderChanged: () => void;
  totalMemoryBytes?: () => number;
  /** Test seam: the downloader. */
  download?: typeof downloadModel;
}

export class LocalModelService {
  private readonly proxy: LocalModelProxy;
  private download: {
    modelId: string;
    abort: AbortController;
    progress: LocalModelProgress;
  } | null = null;
  private started = false;

  constructor(private readonly options: LocalModelServiceOptions) {
    this.proxy = new LocalModelProxy({
      serverFor: (modelId) => {
        const spec = localModelSpec(modelId);
        return spec != null && installedModels().includes(spec)
          ? new LlamaServer(spec.id, modelPath(spec))
          : null;
      },
      defaultModelId: () => this.preferredInstalled()?.id ?? null,
    });
  }

  /**
   * Bring the endpoint up if anything is installed. At app start, and again
   * after the first install; a machine with no local model runs no proxy.
   */
  async start(): Promise<void> {
    if (this.started || !llamaServerAvailable()) return;
    if (installedModels().length === 0) return;
    await this.proxy.listen();
    this.started = true;
    this.registerProvider();
  }

  dispose(): void {
    this.download?.abort.abort();
    this.proxy.close();
    this.started = false;
  }

  state(): LocalModelState {
    const totalMemoryBytes = this.options.totalMemoryBytes?.() ?? os.totalmem();
    return {
      runtimeAvailable: llamaServerAvailable(),
      totalMemoryBytes,
      recommendedId: recommendLocalModel(totalMemoryBytes).id,
      catalog: LOCAL_MODEL_CATALOG,
      installedIds: installedModels().map((spec) => spec.id),
      download: this.download?.progress ?? null,
      servingId: this.proxy.servingId,
    };
  }

  /**
   * Download the model and register it. Resolves when it is ready to use
   * (`local/<id>`), or with what went wrong; progress goes out as events.
   */
  async install(
    modelId: string
  ): Promise<{ ok: true; model: string } | { ok: false; error: string }> {
    const spec = localModelSpec(modelId);
    if (spec == null) return { ok: false, error: `unknown model ${modelId}` };
    if (!llamaServerAvailable())
      return { ok: false, error: "this build cannot run local models" };
    if (this.download != null)
      return { ok: false, error: "a download is already running" };

    const abort = new AbortController();
    const progress: LocalModelProgress = {
      modelId,
      phase: "downloading",
      receivedBytes: 0,
      totalBytes: spec.sizeBytes,
    };
    this.download = { modelId, abort, progress };
    const report = (patch: Partial<LocalModelProgress>): void => {
      Object.assign(progress, patch);
      this.options.onProgress({ ...progress });
    };

    try {
      let lastReported = 0;
      await (this.options.download ?? downloadModel)(spec, {
        signal: abort.signal,
        onProgress: (receivedBytes) => {
          // A few events a second, not one per chunk.
          if (
            receivedBytes === spec.sizeBytes ||
            receivedBytes - lastReported > 4 * 1024 * 1024
          ) {
            lastReported = receivedBytes;
            report({ receivedBytes });
          }
        },
      });
      report({ phase: "verifying", receivedBytes: spec.sizeBytes });
      await this.start();
      this.registerProvider();
      report({ phase: "ready" });
      return { ok: true, model: `${LOCAL_PROVIDER_ID}/${spec.id}` };
    } catch (error) {
      const cancelled = abort.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      report({
        phase: cancelled ? "cancelled" : "failed",
        ...(cancelled ? {} : { error: message }),
      });
      return { ok: false, error: cancelled ? "cancelled" : message };
    } finally {
      this.download = null;
    }
  }

  cancelInstall(): void {
    this.download?.abort.abort();
  }

  remove(modelId: string): void {
    const spec = localModelSpec(modelId);
    if (spec == null) return;
    if (this.proxy.servingId === spec.id) this.proxy.unload();
    removeModel(spec);
    this.registerProvider();
  }

  /** The biggest installed model this machine is recommended: what "local" means by default. */
  private preferredInstalled(): LocalModelSpec | undefined {
    const installed = installedModels();
    const recommended = recommendLocalModel(
      this.options.totalMemoryBytes?.() ?? os.totalmem()
    );
    return (
      installed.find((spec) => spec.id === recommended.id) ?? installed.at(-1)
    );
  }

  /** config.json's `local` provider mirrors what is installed; gone when nothing is. */
  private registerProvider(): void {
    const installed = installedModels();
    if (installed.length === 0 || !this.started) {
      removeCustomProvider(LOCAL_PROVIDER_ID);
    } else {
      upsertCustomProvider({
        id: LOCAL_PROVIDER_ID,
        name: "On this machine",
        baseUrl: this.proxy.baseUrl,
        models: installed.map((spec) => ({
          id: spec.id,
          name: spec.label,
          contextWindow: LOCAL_MODEL_CONTEXT,
          maxTokens: 8_192,
        })),
      });
    }
    this.options.onProviderChanged();
  }
}
