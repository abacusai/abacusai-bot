/**
 * The toolset registry: every capability the agent can be given, grouped as the
 * Capabilities panel toggles it. Tool names are the ones pi registers; renaming
 * them would mean an alias shim plus a rewrite of the renderer, gate and every
 * transcript. In `shared/` because the renderer draws the panel from it and the
 * main process turns disabled groups into `excludeTools`; they must agree.
 */

/** `planned` means nothing implements it yet; it is not "needs setup". */
export type ToolsetStatus = "ready" | "planned";

/**
 * How an enabled group's tools reach the agent. `builtin` is pi's own, withheld
 * via `excludeTools`; `mcp-browser`/`mcp-device` toggles drive those servers'
 * own enable flags; `mcp-agent-tools` share one server that filters its list;
 * `agent` tools are registered by the agent process and withheld like pi's,
 * which is why each also carries `agentDelivered`.
 */
export type ToolsetDelivery =
  | "builtin"
  | "agent"
  | "mcp-browser"
  | "mcp-device"
  | "mcp-agent-tools";

export interface ToolsetTool {
  /** The wire name the model calls. An identifier, never translated. */
  name: string;
  /** i18n key under `capabilities.toolDescriptions`. */
  descriptionKey: string;
  /**
   * True for a tool the agent process registers itself in a group whose other
   * tools arrive by MCP; one switch withholds both, by different mechanisms.
   */
  agentDelivered?: boolean;
}

export interface Toolset {
  /** Stable id. Used as the settings key, so it must not change once shipped. */
  id: string;
  /** i18n key under `capabilities.toolsets`, for the group's display name. */
  labelKey: string;
  status: ToolsetStatus;
  /** Only meaningful when `status` is `ready`. */
  delivery?: ToolsetDelivery;
  tools: ToolsetTool[];
  /**
   * On by default when it works with no setup and cannot act outside the app.
   * Off for reach (unattended runs, real lights) or dead weight (a toolset
   * needing a key nobody has costs prompt budget on every request).
   */
  defaultEnabled: boolean;
  /**
   * Listed but not switchable: the server serves these whatever the toggles
   * say, so a switch would be a lie.
   */
  alwaysOn?: boolean;
}

const tool = (name: string): ToolsetTool => ({ name, descriptionKey: name });

/** A tool the agent process registers itself. See `ToolsetTool.agentDelivered`. */
const agentTool = (name: string): ToolsetTool => ({
  name,
  descriptionKey: name,
  agentDelivered: true,
});

/**
 * Core coding toolsets first, then the rest alphabetically. Not the panel's
 * order (`TOOLSETS_FOR_DISPLAY`), so graduating a toolset is a one-word edit.
 */
export const TOOLSETS: Toolset[] = [
  // ── Core coding ──────────────────────────────────────────────────────────
  {
    id: "file",
    labelKey: "file",
    status: "ready",
    delivery: "builtin",
    // Search lives here: "can it look through my files" is "can it read them".
    tools: [
      tool("read"),
      // Several files in one turn, not one model turn per file.
      tool("batch_file_read"),
      tool("write"),
      tool("edit"),
      // Several changes to one file in one call.
      tool("batch_edit"),
      // Structural editing: the model describes a pattern and the splice is
      // exact, removing the line numbers and whitespace cheap models get wrong.
      tool("ast_edit"),
      tool("code_map"),
      tool("grep"),
      tool("glob"),
      tool("ls"),
    ],
    defaultEnabled: true,
  },
  {
    id: "terminal",
    labelKey: "terminal",
    status: "ready",
    delivery: "builtin",
    // Long-running children are the `process` group's job; `background: true`
    // hands a command over to that machinery.
    tools: [tool("bash"), tool("run_tests")],
    defaultEnabled: true,
  },
  {
    /**
     * Commands that outlive one tool call, and output too big for one. Always
     * on: `bash` can background a job whatever is switched on here, so a switch
     * would strand jobs the agent can start but not read or stop. `read_output`
     * sits here because ANY trimmed result, not just a shell one, points at it.
     */
    id: "process",
    labelKey: "process",
    status: "ready",
    delivery: "agent",
    tools: [
      agentTool("fetch_background_output"),
      agentTool("kill_process"),
      agentTool("read_output"),
    ],
    defaultEnabled: true,
    alwaysOn: true,
  },
  {
    /**
     * Listed so the tool that ends plan mode is findable, not switchable: the
     * way out of a mode must not depend on which toolsets happen to be on.
     */
    id: "plan_mode",
    labelKey: "plan_mode",
    status: "ready",
    delivery: "agent",
    tools: [agentTool("exit_plan_mode")],
    defaultEnabled: true,
    alwaysOn: true,
  },
  {
    // `browser_task` hands the job to a sub-agent holding the four raw tools
    // (packages/agent/src/browser-task.ts). The raw tools stay listed because
    // they are what runs; turning off `browser_task` alone puts them back in
    // the main loop, the escape hatch when a task needs steering by hand.
    id: "browser",
    labelKey: "browser",
    status: "ready",
    delivery: "mcp-browser",
    tools: [
      tool("browser_task"),
      tool("browser_navigate"),
      tool("browser_snapshot"),
      tool("browser_interact"),
      tool("browser_execute"),
    ],
    defaultEnabled: true,
  },
  {
    // Driving iOS simulators and Android emulators.
    id: "device",
    labelKey: "device",
    status: "ready",
    delivery: "mcp-device",
    tools: [
      tool("device_list"),
      tool("device_boot"),
      tool("device_shutdown"),
      tool("device_build"),
      tool("device_app"),
      tool("device_screenshot"),
      tool("device_snapshot"),
      tool("device_interact"),
      tool("device_logs"),
    ],
    // Off by default: every tool here needs a toolchain most people do not
    // have, and nine unusable tools only give the model wrong things to try.
    defaultEnabled: false,
  },

  // ── The rest ─────────────────────────────────────────────────────────────
  // Planned groups list the tool names the implementation will expose.
  {
    id: "a2a",
    labelKey: "a2a",
    status: "planned",
    // Agent-to-agent protocol; needs a plugin host too, so no tools listed yet.
    tools: [],
    defaultEnabled: false,
  },
  {
    id: "bfl",
    labelKey: "bfl",
    status: "ready",
    delivery: "mcp-agent-tools",
    tools: [
      tool("bfl_flux3_text_to_video"),
      tool("bfl_flux3_image_to_video"),
      tool("bfl_flux3_keyframes_to_video"),
      tool("bfl_flux3_video_continuation"),
      tool("bfl_flux3_get_result"),
      tool("bfl_flux3_prompting_guide"),
    ],
    defaultEnabled: false,
  },
  {
    id: "connectors",
    labelKey: "connectors",
    status: "ready",
    delivery: "mcp-agent-tools",
    tools: [tool("connect_connector"), tool("disconnect_connector")],
    // On by default: it asks the user rather than acting, so it grants nothing,
    // and without it the agent can only report that a service is not attached.
    defaultEnabled: true,
  },
  {
    // On by default: "every weekday at 8am, go through the email" is a routine
    // being asked for, and what it makes is an editable, pausable card under
    // Settings → Routines. Bots keep it whatever this says (BOT_ALWAYS).
    id: "cronjob",
    labelKey: "cronjob",
    status: "ready",
    delivery: "mcp-agent-tools",
    tools: [tool("cronjob")],
    defaultEnabled: true,
  },
  {
    id: "delegation",
    labelKey: "delegation",
    status: "ready",
    delivery: "builtin",
    tools: [tool("delegate_task")],
    defaultEnabled: true,
  },
  {
    id: "homeassistant",
    labelKey: "homeassistant",
    status: "ready",
    delivery: "mcp-agent-tools",
    tools: [
      tool("ha_list_entities"),
      tool("ha_get_state"),
      tool("ha_list_services"),
      tool("ha_call_service"),
    ],
    defaultEnabled: false,
  },
  {
    id: "image_gen",
    labelKey: "image_gen",
    status: "ready",
    delivery: "mcp-agent-tools",
    tools: [tool("image_generate")],
    defaultEnabled: false,
  },
  {
    id: "deliverables",
    labelKey: "deliverables",
    status: "ready",
    delivery: "mcp-agent-tools",
    tools: [tool("present_deliverable"), tool("serve")],
    defaultEnabled: true,
    // Always on: a turn that produced files has something to hand over.
    alwaysOn: true,
  },
  {
    id: "memory",
    labelKey: "memory",
    status: "ready",
    delivery: "mcp-agent-tools",
    tools: [tool("memory")],
    defaultEnabled: true,
  },
  {
    id: "messaging",
    labelKey: "messaging",
    status: "ready",
    delivery: "mcp-agent-tools",
    // One tool per platform, listed only while that platform is connected, so
    // one platform's contacts never appear beside another's. *_auto_reply is
    // bots-only.
    tools: [
      tool("list_whatsapp_chats"),
      tool("send_whatsapp_message"),
      tool("read_whatsapp_messages"),
      tool("whatsapp_auto_reply"),
      tool("list_telegram_chats"),
      tool("send_telegram_message"),
      tool("read_telegram_messages"),
      tool("telegram_auto_reply"),
      tool("list_discord_chats"),
      tool("send_discord_message"),
      tool("read_discord_messages"),
      tool("discord_auto_reply"),
    ],
    // On by default at no cost: the server withholds both tools until a
    // messaging platform is running, and sending is why one gets connected.
    defaultEnabled: true,
  },
  {
    id: "design",
    labelKey: "design",
    status: "ready",
    delivery: "agent",
    tools: [agentTool("design"), tool("present_deliverable")],
    // On by default: no setup beyond a key checked at call time.
    defaultEnabled: true,
  },
  {
    id: "pdf",
    labelKey: "pdf",
    status: "ready",
    delivery: "mcp-agent-tools",
    tools: [agentTool("document"), tool("pdf"), tool("present_deliverable")],
    // On by default: reading a PDF is table stakes and writing one needs no
    // setup.
    defaultEnabled: true,
  },
  {
    id: "ppt",
    labelKey: "ppt",
    status: "ready",
    delivery: "mcp-agent-tools",
    tools: [
      agentTool("ppt"),
      tool("deck_export_pdf"),
      tool("present_deliverable"),
    ],
    // On by default: no setup beyond a key checked at call time.
    defaultEnabled: true,
  },
  {
    id: "session_search",
    labelKey: "session_search",
    status: "ready",
    // Registered by the agent process, not the tool server, so the CLI has it
    // too.
    delivery: "agent",
    tools: [agentTool("session_search")],
    defaultEnabled: true,
  },
  {
    id: "skills",
    labelKey: "skills",
    status: "ready",
    delivery: "mcp-agent-tools",
    // `skill_add` is registered by the agent process so the CLI, which has no
    // Skills dialog, can install one too.
    tools: [
      tool("skills_list"),
      tool("skill_view"),
      tool("skill_manage"),
      agentTool("skill_add"),
    ],
    defaultEnabled: true,
  },
  {
    id: "spotify",
    labelKey: "spotify",
    status: "planned",
    tools: [
      tool("spotify_playback"),
      tool("spotify_devices"),
      tool("spotify_queue"),
      tool("spotify_search"),
      tool("spotify_playlists"),
      tool("spotify_albums"),
      tool("spotify_library"),
    ],
    defaultEnabled: false,
  },
  {
    id: "todo",
    labelKey: "todo",
    status: "ready",
    delivery: "mcp-agent-tools",
    tools: [tool("todo")],
    defaultEnabled: true,
  },
  {
    id: "tts",
    labelKey: "tts",
    status: "ready",
    delivery: "mcp-agent-tools",
    tools: [tool("text_to_speech")],
    defaultEnabled: false,
  },
  {
    id: "video",
    labelKey: "video",
    status: "ready",
    delivery: "mcp-agent-tools",
    tools: [tool("video_analyze")],
    defaultEnabled: false,
  },
  {
    id: "video_gen",
    labelKey: "video_gen",
    status: "ready",
    delivery: "mcp-agent-tools",
    tools: [
      tool("video_generate"),
      tool("xai_video_edit"),
      tool("xai_video_extend"),
    ],
    defaultEnabled: false,
  },
  {
    id: "vision",
    labelKey: "vision",
    status: "ready",
    delivery: "mcp-agent-tools",
    tools: [tool("vision_analyze")],
    defaultEnabled: true,
  },
  {
    id: "web",
    labelKey: "web",
    status: "ready",
    // Delivered by the agent, where the one web search implementation lives.
    // `web_fetch` needs no credential and fences what it reads as untrusted.
    delivery: "agent",
    tools: [agentTool("web_search"), agentTool("web_fetch")],
    defaultEnabled: true,
  },
  {
    id: "x_search",
    labelKey: "x_search",
    status: "ready",
    delivery: "mcp-agent-tools",
    tools: [tool("x_search")],
    // On by default: it reads public posts and cannot act. Without xAI Live
    // Search keyed it withholds itself and the agent's own x_search answers.
    defaultEnabled: true,
  },
];

export const TOOLSETS_BY_ID: ReadonlyMap<string, Toolset> = new Map(
  TOOLSETS.map((set) => [set.id, set])
);

/**
 * What the panel lists: only the groups that work. Switches that do nothing
 * read as a half-built app; `TOOLSETS` still declares planned groups, so
 * graduating one is a one-word status change.
 */
export const TOOLSETS_FOR_DISPLAY: Toolset[] = TOOLSETS.filter(
  (set) => set.status === "ready"
);

/** Groups whose tools exist today — the only ones a toggle can actually deliver. */
export const READY_TOOLSETS: Toolset[] = TOOLSETS.filter(
  (set) => set.status === "ready"
);

/**
 * Tools reachable right now, counted by distinct name: `present_deliverable`
 * is listed under every producing group and must not count five times.
 */
export const READY_TOOL_COUNT = new Set(
  READY_TOOLSETS.flatMap((set) => set.tools.map((entry) => entry.name))
).size;

/** The stored on/off state, keyed by toolset id. Absent means "use the default". */
export type ToolsetPreferences = Record<string, boolean>;

export const isToolsetEnabled = (
  id: string,
  preferences: ToolsetPreferences | undefined
): boolean => {
  const toolset = TOOLSETS_BY_ID.get(id);

  if (toolset == null) return false;
  // A planned group can never be on: there is nothing behind the switch.
  if (toolset.status === "planned") return false;
  // An always-on group has no switch; honouring a stale stored `false` would
  // withhold agent-registered tools while the panel still showed them on.
  if (toolset.alwaysOn === true) return true;

  return preferences?.[id] ?? toolset.defaultEnabled;
};

/**
 * Tool names the agent process must withhold for every group switched off: a
 * `builtin` group's tools plus any `agentDelivered` tool. MCP-delivered tools
 * are absent on purpose; their server filters its own `tools/list`.
 */
export const excludedBuiltinTools = (
  preferences: ToolsetPreferences | undefined
): string[] =>
  TOOLSETS.filter((set) => !isToolsetEnabled(set.id, preferences)).flatMap(
    (set) =>
      set.tools
        .filter(
          (entry) => set.delivery === "builtin" || entry.agentDelivered === true
        )
        .map((entry) => entry.name)
  );
