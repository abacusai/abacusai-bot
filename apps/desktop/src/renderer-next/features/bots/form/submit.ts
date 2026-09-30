import type { Db } from "#next/data/db";
import type { Transport } from "#next/data/transport";
import {
  CHECK_IN_PROMPT,
  findCheckIn,
  NAME_ONLY_MISSION,
  checkInPersistence,
  checkInFromRoutine,
  describeCheckIn,
  type CheckInDraft,
} from "#next/lib/bots/check-in";
import type { BotRow, RoutineRow } from "#shared/contract/rows";

import {
  createBot,
  updateBot,
  announceChange,
  newRoutineId,
} from "../data/bot-actions";
import { openChatOnce } from "../data/open-chat";
import type { BotDraft } from "./draft-store";
import { editedPatch, equalValue, type BotFormValues } from "./schema";
export const persistCheckIn = async (
  db: Db,
  bot: Pick<BotRow, "id" | "name">,
  before: RoutineRow | null,
  draft: CheckInDraft,
  routineName: string
): Promise<void> => {
  const action = checkInPersistence(before, draft, true);
  if (action.kind === "none") return;
  if (action.kind === "delete") {
    await db.collections.routines.delete(action.id).isPersisted.promise;
    return;
  }
  if (action.kind === "update") {
    await db.collections.routines.update(action.id, (row) => {
      if (action.schedule !== undefined) row.schedule = action.schedule;
      if (action.enabled !== undefined) row.enabled = action.enabled;
    }).isPersisted.promise;
    return;
  }
  const row: RoutineRow = {
    id: newRoutineId(),
    name: routineName,
    schedule: action.schedule,
    enabled: action.enabled,
    prompt: CHECK_IN_PROMPT,
    runAt: null,
    webhookToken: null,
    workspaceId: null,
    botId: bot.id,
    createdAt: Date.now(),
    lastRunAt: null,
    lastResult: null,
    nextRunAt: null,
    webhookUrl: null,
    webhookPublicPending: false,
    botName: bot.name,
    recentRuns: [],
  };
  await db.collections.routines.insert(row).isPersisted.promise;
  // RoutineCreateInput has no enabled field. A paused draft needs the separate update.
  if (!action.enabled)
    await db.collections.routines.update(row.id, (draft) => {
      draft.enabled = false;
    }).isPersisted.promise;
};
const boundedReadiness = async (
  ready: () => Promise<unknown>,
  ms = 5000
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } catch {
    /* The destination loader owns Retry after persistence. */
  } finally {
    clearTimeout(timer);
  }
};
export interface SubmitDeps {
  db: Db;
  transport: Transport;
  load(sessionId: string): Promise<unknown>;
  navigate(id: string): Promise<unknown>;
  routineName: string;
  checkInFailed(retry: () => Promise<void>): void;
}
export const submitCreate = async (
  deps: SubmitDeps,
  draft: BotDraft,
  values: BotFormValues,
  saveStage: (draft: BotDraft) => void
): Promise<void> => {
  let row: BotRow = {
    id: draft.id,
    name: values.name,
    title: values.description,
    description: values.instructions || NAME_ONLY_MISSION,
    persona: values.persona,
    avatarShape: values.look.shape,
    avatarColor: values.look.color,
    avatarAccessory: values.look.accessory,

    model: values.model,
    channel: null,
    workspaceId: null,
    sessionId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (!draft.stages.bot) {
    const id = await createBot(deps.db.collections.bots, row);
    row = { ...row, id };
    draft.id = id;
    draft.stages.bot = true;
    saveStage(draft);
  }
  let navigating = false;
  const saveCheckIn = async (): Promise<void> => {
    await persistCheckIn(
      deps.db,
      row,
      findCheckIn(deps.db.collections.routines.toArray, row.id),
      values.checkIn,
      deps.routineName
    );
    draft.stages.checkIn = "persisted";
    if (!navigating) saveStage(draft);
  };
  if (values.checkIn.preset !== "off" && draft.stages.checkIn !== "persisted") {
    try {
      await saveCheckIn();
    } catch {
      draft.stages.checkIn = "failed";
      saveStage(draft);
      deps.checkInFailed(saveCheckIn);
    }
  }
  await boundedReadiness(async () => {
    const bot = deps.db.collections.bots.get(row.id) ?? row;
    const handle = await openChatOnce(
      { transport: deps.transport, sessions: deps.db.collections.sessions },
      bot
    );
    await deps.load(handle.sessionId);
  });
  navigating = true;
  await deps.navigate(row.id);
};
export const submitEdit = async (
  deps: SubmitDeps,
  bot: BotRow,
  _before: RoutineRow | null,
  values: BotFormValues,
  baseline: BotFormValues
): Promise<void> => {
  const patch = editedPatch(values, baseline);
  if (patch.description === "") patch.description = NAME_ONLY_MISSION;
  const checkInChanged = !equalValue(values.checkIn, baseline.checkIn);
  const scheduleEdited = !equalValue(
    { ...values.checkIn, enabled: baseline.checkIn.enabled },
    baseline.checkIn
  );
  const enabledEdited = values.checkIn.enabled !== baseline.checkIn.enabled;
  await updateBot(deps.db.collections.bots, bot.id, patch);
  const currentRoutine = findCheckIn(
    deps.db.collections.routines.toArray,
    bot.id
  );
  const liveCheckIn = checkInFromRoutine(currentRoutine);
  const mergedCheckIn = {
    ...(scheduleEdited ? values.checkIn : liveCheckIn),
    enabled: enabledEdited ? values.checkIn.enabled : liveCheckIn.enabled,
  };
  if (checkInChanged)
    await persistCheckIn(
      deps.db,
      { id: bot.id, name: values.name },
      currentRoutine,
      mergedCheckIn,
      deps.routineName
    );
  announceChange(deps.transport, bot.id, {
    ...(patch.description !== undefined ? { mission: true } : {}),
    ...(patch.persona !== undefined ? { persona: true } : {}),
    ...(scheduleEdited && values.checkIn.preset !== "custom"
      ? {
          checkIn: describeCheckIn({
            ...values.checkIn,
            preset: values.checkIn.preset,
          }),
        }
      : {}),
  });
  if (bot.sessionId) await boundedReadiness(() => deps.load(bot.sessionId!));
  await deps.navigate(bot.id);
};
