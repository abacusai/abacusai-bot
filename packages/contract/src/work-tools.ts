/**
 * Whether a tool call built or changed something (work) or only looked
 * (a read, a search, an answer). The offers under a reply read it: the retry
 * offer counts a failure or a complaint only after work, the deliverable offer
 * stays off a turn that already made something, and the rating line asks
 * sooner after work.
 *
 * It is "work unless it only looks", so a tool the app has never heard of
 * (a connector's, or a server the user added) counts by what its name or its
 * `action` says, never by being on a list: `execute_luau`, `start_stop_play`
 * and `send_email` are work, `get_console_output`, `script_read` and
 * `search_email` are not. The first verb in the name decides, wherever it
 * sits (`get_build_status` reads, `screen_capture` reads, `multi_edit` edits);
 * a name with no verb is work.
 */

/** Verbs of a call that only looks. */
const LOOK_VERBS = new Set([
  "analyse",
  "analyze",
  "browse",
  "capture",
  "check",
  "compare",
  "count",
  "describe",
  "diff",
  "download",
  "explore",
  "fetch",
  "find",
  "get",
  "glob",
  "grep",
  "history",
  "hover",
  "info",
  "inspect",
  "list",
  "look",
  "logs",
  "lookup",
  "ls",
  "navigate",
  "peek",
  "poll",
  "preview",
  "query",
  "read",
  "retrieve",
  "scan",
  "scrape",
  "screenshot",
  "scroll",
  "search",
  "show",
  "snapshot",
  "status",
  "summarize",
  "validate",
  "verify",
  "view",
  "wait",
]);

/** Verbs of a call that builds or changes something. */
const WORK_VERBS = new Set([
  "add",
  "append",
  "apply",
  "approve",
  "archive",
  "assign",
  "book",
  "build",
  "call",
  "cancel",
  "click",
  "commit",
  "convert",
  "copy",
  "create",
  "delete",
  "deploy",
  "disable",
  "draft",
  "edit",
  "enable",
  "exec",
  "execute",
  "export",
  "fill",
  "fix",
  "forward",
  "generate",
  "import",
  "insert",
  "install",
  "interact",
  "invite",
  "kill",
  "launch",
  "make",
  "merge",
  "modify",
  "move",
  "patch",
  "pay",
  "play",
  "post",
  "publish",
  "push",
  "put",
  "remove",
  "rename",
  "render",
  "replace",
  "reply",
  "reset",
  "restart",
  "run",
  "save",
  "schedule",
  "send",
  "set",
  "share",
  "start",
  "stop",
  "submit",
  "sync",
  "trash",
  "uninstall",
  "update",
  "upload",
  "upsert",
  "write",
]);

/**
 * The app's own tools whose name says nothing, or says the wrong thing:
 * answers, cards and bookkeeping that change nothing the user asked for.
 */
const ANSWER_TOOLS = new Set([
  "ask_user_question",
  "bfl_flux3_prompting_guide",
  "billing_plan",
  "bot_help",
  "code_map",
  "connect_connector",
  "current_time",
  "disconnect_connector",
  "exit_plan_mode",
  "memory",
  "my_activity",
  "offer_session",
  "paid_feature",
  "set_user_language",
  "suggest_tasks",
  "todo",
  "todo_write",
  "vault_items",
]);

/** The prefix the app's own tool server puts on a tool's name. */
const OWN_SERVER_PREFIX = "agent-tools_";

/** The words of a name: `roblox-studio_get_console_output`, `Gmail_Tool`, `getFile`. */
const nameWords = (name: string): string[] =>
  name
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");

/** What the first verb in a name says: work, a look, or nothing. */
const verbSays = (name: string): boolean | null => {
  for (const word of nameWords(name)) {
    if (WORK_VERBS.has(word)) return true;
    if (LOOK_VERBS.has(word)) return false;
  }
  return null;
};

/**
 * Whether this call built or changed something. A multi-action tool (a
 * connector's `Gmail_Tool`, `serve`, `cronjob`) is judged by its `action`
 * when that names a verb, so `serve list` is a look and `send_email` work.
 */
export const isWorkCall = (
  name: string,
  input: Readonly<Record<string, unknown>> = {}
): boolean => {
  const bare = name.startsWith(OWN_SERVER_PREFIX)
    ? name.slice(OWN_SERVER_PREFIX.length)
    : name;
  if (ANSWER_TOOLS.has(bare)) return false;
  const action =
    typeof input.action === "string" ? verbSays(input.action) : null;
  return action ?? verbSays(bare) ?? true;
};
