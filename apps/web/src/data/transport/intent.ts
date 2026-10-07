/**
 * What a call is, by procedure (spec 09 D2), as the host transport needs to
 * know before a socket is open. The contract marks every procedure a
 * `query`, a `subscription` or a `mutation` (`base.ts`); the renderer does
 * not ship the contract's schemas, so the reads are listed here and a test
 * holds the list equal to the contract (`intent.test.ts`).
 *
 * - A read (query or subscription) waits for a socket as long as its own
 *   signal allows, or the page lives. It is never held for authorization.
 * - A write waits until the sign-in gate has authorized writes, and at most
 *   `WRITE_DEADLINE_MS` from the call; it then fails `HOST_UNAVAILABLE` and
 *   is never dispatched afterwards.
 * - Two writes differ: `bots.openChat` is idempotent per bot (`openChatOnce`)
 *   and awaited by the bot chat's loader, so it waits without a deadline;
 *   `system.activity` feeds the host's idle clock and carries no user data,
 *   so it is not held for authorization. `system.acknowledgeLegacyDrafts` is
 *   background work and waits without a deadline too.
 */

/** `"account": "abacus state usage"` reads `account.abacus`, … */
const READS: Record<string, string> = {
  account: "abacus state usage",
  agent: "queue.get skills state",
  ai: "attention hydrate joinRun runFinished subscribe",
  auth: "abacus.browserProfiles abacus.shouldAutoSignIn",
  bots: "chatPreviews events senderChats",
  browser: "events permissions.list profiles.list status",
  connectors: "events requests statuses",
  db: [
    "artifacts",
    "bots",
    "gitState",
    "memories",
    "prefs",
    "routineRuns",
    "routines",
    "sessions",
    "workspaces",
  ]
    .map((table) => `${table}.changes ${table}.snapshot`)
    .join(" "),
  devices: "events list projectInfo simulatorWindowSource status stream.chunks",
  files:
    "events readImageAsDataUrl readPptx readText search treeChildren treeRoot",
  git: "branches checkoutStatus currentBranch diff prInfo watch worktrees.list",
  localModels: "progress state",
  mcp: "list runtime.events runtime.logs runtime.servers",
  memory: "bots customInstructions.get events",
  messaging: "events snapshot",
  models: "list",
  notch: "events layout openCommands status",
  referrals: "gmailContacts summary whatsappContacts",
  routines: "events",
  sessions: "turnState",
  settings:
    "defaultMode.get events execBackend.get get keys.listProviders notifications.get promptHistory.list sandboxSupport toolsets.get",
  skills: "listInstalled search",
  system: "events info loginItem.get",
  terminal: "events output shell.get",
  update: "events status",
  voice: "whisper.progress",
  window: "chrome events state",
  workspaces: "checkPath sessionHomePath",
};

const reads = new Set(
  Object.entries(READS).flatMap(([group, names]) =>
    names.split(" ").map((name) => `${group}.${name}`)
  )
);

const PATIENT_WRITES = new Set([
  "bots.openChat",
  "system.acknowledgeLegacyDrafts",
]);
const UNGATED_WRITES = new Set(["system.activity"]);

export interface CallPolicy {
  /** Held until the sign-in gate authorizes writes. */
  readonly authorize: boolean;
  /** Fails `HOST_UNAVAILABLE` after the write deadline, unsent. */
  readonly deadline: boolean;
}

const READ: CallPolicy = { authorize: false, deadline: false };
const WRITE: CallPolicy = { authorize: true, deadline: true };
const PATIENT: CallPolicy = { authorize: true, deadline: false };
const UNGATED: CallPolicy = { authorize: false, deadline: true };

/** An unknown path is a write: held and bounded, never sent early. */
export const policyOf = (path: readonly string[]): CallPolicy => {
  const procedure = path.join(".");
  if (reads.has(procedure)) return READ;
  if (PATIENT_WRITES.has(procedure)) return PATIENT;
  if (UNGATED_WRITES.has(procedure)) return UNGATED;
  return WRITE;
};

/** Every procedure listed as a read (the contract test compares them). */
export const readProcedures = (): ReadonlySet<string> => reads;
