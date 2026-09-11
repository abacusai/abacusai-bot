/**
 * Which model a chat runs on. An explicit dropdown pick outranks everything;
 * then the session's own model, so a chat begun on one model never silently
 * continues on another; the workspace and global picks only seed a session
 * that has never run.
 */
export interface ModelSelectionInput {
  /** A model just chosen in the dropdown, until the session reports running it. */
  userPick?: string | null;
  /** What this session last ran with: live CLI state, else the stored record. */
  sessionModel: string | null | undefined;
  workspaceModel: string | null | undefined;
  globalModel: string | null | undefined;
  /** Ids currently runnable. Empty means the roster is not loaded. */
  runnableModelIds?: readonly string[];
}

// '' when nothing is resolvable. A model no longer runnable falls through
// rather than failing on the first token; an unloaded roster filters nothing,
// or every session's model would drop on every startup.
export const resolveModelForSession = (input: ModelSelectionInput): string => {
  const { runnableModelIds } = input;
  const runnable = (id: string): boolean =>
    runnableModelIds == null ||
    runnableModelIds.length === 0 ||
    runnableModelIds.includes(id);

  for (const candidate of [
    input.userPick,
    input.sessionModel,
    input.workspaceModel,
    input.globalModel,
  ]) {
    const id = candidate?.trim() ?? "";
    if (id.length > 0 && runnable(id)) return id;
  }

  return "";
};

// The gate on activeSessionId is the point: the session-state query keeps the
// previous chat's model as placeholder data while refetching, and without the
// gate a new chat's pick resolves straight back to it.
export const sessionModelFor = (input: {
  /** Null on a new chat that has never been created. */
  activeSessionId: string | null;
  liveModel: string | null | undefined;
  /** All a stopped chat has. */
  storedModel: string | null | undefined;
}): string | null =>
  input.activeSessionId == null
    ? null
    : (input.liveModel ?? input.storedModel ?? null);

/**
 * Whether a dropdown pick has been honoured and can stop outranking the
 * session. Live state only: the picker writes the stored record immediately,
 * so accepting it as evidence would read back what was just written. A
 * stopped session reports no live model, so its pick is held until it starts.
 */
export const modelPickHonoured = (
  pick: string | null | undefined,
  liveSessionModel: string | null | undefined
): boolean => {
  const picked = pick?.trim() ?? "";

  return picked.length > 0 && picked === (liveSessionModel?.trim() ?? "");
};

// How long an agent has to answer a model pick. Longer than the slowest honest
// answer (a catalog re-fetch is allowed 8s); the backstop for a wedged agent.
export const MODEL_PICK_TIMEOUT_MS = 15_000;

// The set_model refusal on the raw NDJSON stream, or null. A refused pick
// comes back as `model_unavailable`, never `model_changed`, so without this the
// pick is held forever. Returns the agent's message ('' when it sent none).
export const modelUnavailableErrorOf = (payload: unknown): string | null => {
  if (typeof payload !== "object" || payload == null) return null;
  const message = payload as {
    type?: unknown;
    event?: {
      type?: unknown;
      error?: { code?: unknown; message?: unknown } | null;
    } | null;
  };

  if (message.type !== "event") return null;
  const event = message.event;
  if (typeof event !== "object" || event == null) return null;
  if (event.type !== "error") return null;
  if (event.error?.code !== "model_unavailable") return null;

  return typeof event.error.message === "string" ? event.error.message : "";
};
