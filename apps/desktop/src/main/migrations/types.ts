/**
 * The one-time migration runner's step contract (spec 00 C.1). A step only
 * plans: it stages every output under `ctx.staging` and returns the writes
 * (each classified by kind) and removals. The runner commits the plan.
 */

export type WriteKind =
  /** The destination did not exist. */
  | "create"
  /** It exists but is fully regenerable from sources the step leaves alone. */
  | "replace-derived"
  /** It exists and may hold data found nowhere else: backed up first. */
  | "replace-user";

export interface PlannedWrite {
  dest: string;
  /** Under `ctx.staging`. */
  staged: string;
  kind: WriteKind;
}

export interface MigrationPlan {
  writes: PlannedWrite[];
  /** Files moved into the step's backup directory. */
  removals: string[];
  stats: Record<string, number>;
}

export interface MigrationContext {
  /** `abacusBotHome()`. */
  home: string;
  /** `app.getPath("userData")`. */
  userData: string;
  appVersion: string;
  /** `<home>/.migrating/<id>-<name>/`, fresh per attempt. */
  staging: string;
  progress(done: number, total: number, label?: string): void;
  log: (message: string) => void;
}

export interface MigrationStep {
  /** 1, 2, …; never reused, never renumbered. */
  id: number;
  /** kebab-case. */
  name: string;
  plan(ctx: MigrationContext): Promise<MigrationPlan>;
}
