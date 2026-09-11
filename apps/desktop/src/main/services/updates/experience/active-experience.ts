/**
 * Leaf registry answering "is an installed experience active, and where?" so
 * the artifact resolver and window loader import nothing else.
 */
import path from "node:path";

import type { ExperienceStore } from "./experience-store";

let active: ExperienceStore | null = null;

export const setActiveExperienceStore = (
  store: ExperienceStore | null
): void => {
  active = store;
};

/** Null on the packaged baseline. */
export const experienceAgentEntry = (): string | null => {
  const directory = active?.agentDirectory ?? null;

  return directory === null ? null : path.join(directory, "main.js");
};

export const activeExperienceVersion = (): string | null =>
  active?.version ?? null;
