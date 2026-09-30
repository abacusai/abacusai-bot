/**
 * The app's DB collections (spec 00 B.3): module-level singletons over the
 * document's transport. `prefs`, `workspaces` and `sessions` sync at once
 * (the shell needs them); the rest start on first use or a route's
 * `collection.preload()`.
 */
import { createCollection } from "@tanstack/db";

import { getTransport } from "../transport";
import {
  artifactsCollectionOptions,
  botsCollectionOptions,
  gitStateCollectionOptions,
  memoriesCollectionOptions,
  prefsCollectionOptions,
  routineRunsCollectionOptions,
  routinesCollectionOptions,
  sessionsCollectionOptions,
  workspacesCollectionOptions,
} from "./tables";

export const prefsCollection = createCollection(
  prefsCollectionOptions(getTransport)
);
export const workspacesCollection = createCollection(
  workspacesCollectionOptions(getTransport)
);
export const sessionsCollection = createCollection(
  sessionsCollectionOptions(getTransport)
);
export const botsCollection = createCollection(
  botsCollectionOptions(getTransport)
);
export const routinesCollection = createCollection(
  routinesCollectionOptions(getTransport)
);
export const routineRunsCollection = createCollection(
  routineRunsCollectionOptions(getTransport)
);
export const artifactsCollection = createCollection(
  artifactsCollectionOptions(getTransport)
);
export const memoriesCollection = createCollection(
  memoriesCollectionOptions(getTransport)
);
export const gitStateCollection = createCollection(
  gitStateCollectionOptions(getTransport)
);

export {
  ipcCollectionOptions,
  type IpcCollectionConfig,
  type IpcCollectionOptions,
  type IpcCollectionStatus,
  type IpcCollectionUtils,
  type IpcTableClient,
} from "./ipc-collection-options";
export * from "./tables";
