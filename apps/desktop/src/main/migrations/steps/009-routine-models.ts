/**
 * Step 9: a routine keeps its own model. Every routine in `cronjobs.json`
 * saved before routines had one is stamped with what it runs on now, so its
 * next run does not jump: its bot's model, else the stored default. With
 * neither it runs on the plan's model, which this step cannot know offline,
 * so it gets null, the plan's default. Idempotent: a
 * stamped routine, null included, is left alone.
 */
import fs from "node:fs";
import path from "node:path";

import type { MigrationContext, MigrationStep } from "../types";
import { CRONJOBS_FILE_NAME } from "./005-routine-attempt-ids";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

const modelId = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const readJson = (ctx: MigrationContext, file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ctx.home, file), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      ctx.log(`routine models: ${file} skipped: ${String(error)}`);
    return null;
  }
};

/** Each bot's own model, by id. */
const botModels = (ctx: MigrationContext): Map<string, string | null> => {
  const bots = readJson(ctx, "bots.json");
  return new Map(
    (Array.isArray(bots) ? bots : [])
      .filter(isRecord)
      .flatMap((bot) =>
        typeof bot.id === "string" ? [[bot.id, modelId(bot.model)]] : []
      ) as [string, string | null][]
  );
};

export const routineModels = (): MigrationStep => ({
  id: 9,
  name: "routine-models",
  plan: async (ctx) => {
    const dest = path.join(ctx.home, CRONJOBS_FILE_NAME);
    const jobs = readJson(ctx, CRONJOBS_FILE_NAME);
    if (!Array.isArray(jobs))
      return { writes: [], removals: [], stats: { routines: 0 } };

    const settings = readJson(ctx, "config.json");
    const fallback = isRecord(settings) ? modelId(settings.defaultModel) : null;
    const bots = botModels(ctx);
    let stamped = 0;
    const next = jobs.map((job: unknown) => {
      // An entry of another shape is not main's to read: it stays as it is.
      if (!isRecord(job) || typeof job.prompt !== "string" || "model" in job)
        return job;
      stamped += 1;
      const bot = typeof job.botId === "string" ? bots.get(job.botId) : null;
      return { ...job, model: bot ?? fallback };
    });
    const stats = { routines: jobs.length, stamped };
    if (stamped === 0) return { writes: [], removals: [], stats };

    const staged = path.join(ctx.staging, CRONJOBS_FILE_NAME);
    // `cron-store`'s own format.
    fs.writeFileSync(staged, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return {
      writes: [{ dest, staged, kind: "replace-user" }],
      removals: [],
      stats,
    };
  },
});
