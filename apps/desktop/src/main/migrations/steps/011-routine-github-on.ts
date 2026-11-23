/**
 * Step 11: what fires a routine on GitHub news is a list of kinds. A routine
 * saved with `githubReviews: true` (the review-fix routine) now says
 * `githubOn: ["review"]`, the same thing. Idempotent: a routine without the
 * old field is left alone.
 */
import fs from "node:fs";
import path from "node:path";

import type { MigrationStep } from "../types";
import { CRONJOBS_FILE_NAME } from "./005-routine-attempt-ids";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

export const routineGithubOn = (): MigrationStep => ({
  id: 11,
  name: "routine-github-on",
  plan: async (ctx) => {
    const dest = path.join(ctx.home, CRONJOBS_FILE_NAME);
    let jobs: unknown;
    try {
      jobs = JSON.parse(fs.readFileSync(dest, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        ctx.log(
          `routine github: ${CRONJOBS_FILE_NAME} skipped: ${String(error)}`
        );
      jobs = null;
    }
    if (!Array.isArray(jobs))
      return { writes: [], removals: [], stats: { routines: 0, moved: 0 } };

    let moved = 0;
    const next = jobs.map((job: unknown) => {
      // An entry of another shape is not main's to read: it stays as it is.
      if (!isRecord(job) || !("githubReviews" in job)) return job;
      moved += 1;
      const { githubReviews, ...rest } = job;
      return githubReviews === true ? { ...rest, githubOn: ["review"] } : rest;
    });
    const stats = { routines: jobs.length, moved };
    if (moved === 0) return { writes: [], removals: [], stats };

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
