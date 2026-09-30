/**
 * Chat scenarios (spec 02 §11): the agent's recorded goldens replayed as
 * they are, plus builder scenarios for canvas states the goldens do not
 * cover. Each lists the canvas boards it reproduces (`canvas-map` is the
 * coverage table, R2-T29).
 */
import type { StreamChunk, UIMessage } from "@tanstack/ai";

import { v1ToUiMessages } from "#shared/transcript/v1-to-ui-messages";

import * as b from "./builders";
import { golden } from "./goldens";
import type { RelayEvent } from "./relay";

export interface Scenario {
  id: string;
  canvas: string[];
  skin: "bot" | "session";
  /** The log main holds when the view opens. */
  events: () => RelayEvent[];
  /** A migrated (v1) transcript before the first event. */
  history?: () => UIMessage[];
  /** Composer and view overrides the gallery applies. */
  view?: {
    placeholder?: string;
    readOnly?: string;
    busyTurn?: boolean;
    model?: string;
    preStart?: boolean;
    banner?: string;
  };
  /** Canned answer to a send in the gallery (echo + reply). */
  reply?: string;
}

const seqd = (events: readonly StreamChunk[]): RelayEvent[] =>
  events.map((event, index) => ({ seq: index + 1, event }));

const at = (minutesAgo: number): number => Date.now() - minutesAgo * 60_000;

const userTurn = (runId: string, id: string, text: string, when?: number): StreamChunk[] => [
  b.runStarted(runId, when != null ? { timestamp: when } : {}),
  ...b.text(id, "user", text),
];

// ─── bots ───────────────────────────────────────────────────────────────

const botChat = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...userTurn("r1", "u1", "What needs me before noon?", at(30)),
    ...b.text("a1", "assistant", "On it."),
    ...b.text(
      "a2",
      "assistant",
      "Two things. The design review moved to **11:30**, and the contract from legal needs your signature today."
    ),
    b.runFinished("r1", "success", { timestamp: at(29) }),
    ...userTurn("r2", "u2", "Reply to legal that I will sign after lunch.\n\n@/Users/me/Documents/contract-v3.pdf", at(5)),
    b.textStart("a3"),
    ...b.toolCall("c1", "gmail_draft", "a3", { to: "legal@northwind.example", subject: "Contract" }),
    b.toolResult("c1", { text: "Draft saved" }),
    b.textDelta("a3", "Drafted it. Want me to send it from Gmail?"),
    b.textEnd("a3"),
    b.runFinished("r2", "success", { timestamp: at(4) }),
  ]);

const botTyping = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...userTurn("r1", "u1", "What's new in the news today?", at(1)),
    b.textStart("a1"),
    ...b.toolCall("c1", "browser_navigate", "a1", { url: "https://news.example.com" }),
  ]);

const botApproval = (): RelayEvent[] => {
  const d = b.descriptor(
    {
      type: "generic",
      toolName: "gmail_send",
      inputSummary: "To legal@northwind.example: Thanks for the updated contract. I will sign it after lunch today.",
      tool: { id: "c1", name: "gmail_send", type: "other", input: {} },
      displayName: "Send email",
    } as never,
    { id: "p1", toolCallId: "c1", runId: "r1" }
  );
  return seqd([
    ...b.sessionReady("inc-1", "DEFAULT"),
    ...userTurn("r1", "u1", "Reply to legal that I will sign after lunch.", at(2)),
    b.textStart("a1"),
    ...b.toolCall("c1", "gmail_send", "a1", { to: "legal@northwind.example" }),
    ...b.permissionEvents([d], d),
  ]);
};

const botQueue = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...userTurn("r1", "u1", "Draft the weekly update for finance.", at(1)),
    b.textStart("a1"),
    ...b.toolCall("c1", "read", "a1", { path: "notes/week.md" }),
    b.custom("queue.updated", { messages: [{ id: "q-1", message: "Also copy the finance team", waitingFor: "turn" }], dequeued: null }),
  ]);

const botBanners = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    b.custom("agent.notification", {
      severity: "warning",
      message: "You have 120 credits left this month.",
      notificationKey: "credits-low",
    }),
    ...userTurn("r1", "u1", "Summarise my inbox", at(10)),
    ...b.text("a1", "assistant", "Nothing urgent. Three newsletters and a calendar invite."),
    b.runFinished("r1"),
  ]);

const botUnread = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...Array.from({ length: 14 }, (_, index) => [
      ...userTurn(`r${index}`, `u${index}`, `Check item ${index + 1}`, at(300 - index * 10)),
      ...b.text(`a${index}`, "assistant", `Item ${index + 1} is fine. Nothing to do.`),
      b.runFinished(`r${index}`),
    ]).flat(),
  ]);

// ─── sessions ──────────────────────────────────────────────────────────

const sessionRunning = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "DEFAULT"),
    b.custom("skills.loaded", { skills: [{ id: "review", name: "review", description: "Review a diff", location: "" }] }),
    ...userTurn("r1", "u1", "Reopening the sidebar closes the side panel when it is at full width. Find out why and fix it.", at(3)),
    b.textStart("a1"),
    b.textDelta(
      "a1",
      "The restore takes all of its width from the centre column. With the side panel at its maximum the centre has nothing left to give, so the layout cannot be honoured."
    ),
    ...b.toolCall("c1", "read", "a1", { path: "src/renderer/components/layout/workspace-view.tsx", offset: 168, limit: 100 }),
    b.toolResult("c1", { text: "…", display: { lineCount: 101 } }),
    ...b.toolCall("c2", "grep", "a1", { pattern: "setShellPanelVisible" }),
    b.toolResult("c2", { text: "Found 4 matches\nsrc/a.ts:1\nsrc/b.ts:2\nsrc/c.ts:3\nsrc/d.ts:4" }),
    ...b.toolCall("c3", "edit", "a1", { path: "src/renderer/components/layout/workspace-view.tsx" }),
    b.custom("tool.display", {
      toolCallId: "c3",
      data: {
        originalContent: "mainArea: centerSize - restoredSize,",
        newContent: "mainArea: centerSize - fromCenter,\n[oppositeId]: oppositeSize - fromOpposite,",
        additions: 24,
        deletions: 5,
      },
    }),
    b.toolResult("c3", { text: "Edited" }),
    ...b.toolCall("c4", "bash", "a1", { command: "pnpm exec vitest run src/renderer/components/layout" }),
    b.custom("tool.output", { toolCallId: "c4", output: " RUN  v4.1.11\n ✓ layout.test.ts (12 tests)\n" }),
    b.custom("agent.status", { status: "executing-tool" }),
    b.stateSnapshot({
      mode: "DEFAULT",
      modeSource: "startup",
      model: "route-llm",
      incarnation: "inc-1",
      plan: [
        { content: "Take the width from the centre first", status: "completed" },
        { content: "Take the rest from the opposite panel", status: "completed" },
        { content: "Add a test for the full-width case", status: "in_progress" },
        { content: "Run the suite", status: "pending" },
      ],
    }),
    b.custom("queue.updated", { messages: [{ id: "q-1", message: "Also add a test for the full-width case", waitingFor: "step" }], dequeued: null }),
  ]);

const sessionReview = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "ACCEPTEDITS"),
    ...userTurn("r1", "u1", "Rename `useShellState` to `useShell` everywhere.", at(8)),
    b.textStart("a1"),
    ...b.toolCall("c1", "grep", "a1", { pattern: "useShellState" }),
    b.toolResult("c1", { text: "Found 7 matches" }),
    ...b.toolCall("c2", "edit", "a1", { path: "src/shell.ts" }),
    b.toolResult("c2", { text: "Edited", display: { originalContent: "export const useShellState", newContent: "export const useShell", additions: 1, deletions: 1 } }),
    b.textDelta(
      "a1",
      "Done. Seven call sites renamed; the type check passes.\n\n```ts\nexport const useShell = () => useStore(shellStore);\n```\n\nThe rename is mechanical, so $O(n)$ in files touched:\n\n$$\\sum_{i=1}^{n} f_i = 7$$"
    ),
    b.textEnd("a1"),
    b.runFinished("r1", "success", { timestamp: at(7) }),
  ]);

const sessionFailedRateLimit = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "DEFAULT"),
    ...userTurn("r1", "u1", "Write the migration for the new tables.", at(2)),
    b.runError("r1", {
      message: "Claude is rate limited right now.",
      code: "turn_failed",
      detail: "429: Too many requests. Retry in 41s.",
      actions: [{ type: "switch-model", model: "abacus/route-llm", label: "Abacus.AI" }, { type: "retry" }],
    }),
  ]);

const sessionSubagents = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...userTurn("r1", "u1", "Audit the three packages in parallel.", at(4)),
    b.textStart("a1"),
    ...b.toolCall("c1", "delegate_task", "a1", { task: "Audit packages/agent" }),
    ...b.toolCall("c2", "delegate_task", "a1", { task: "Audit packages/connectors" }),
    ...b.toolCall("c3", "delegate_task", "a1", { task: "Audit apps/updater" }),
    b.subagentStarted("sub-1", "delegate", "Audit packages/agent", "c1", "a1"),
    b.subagentStarted("sub-2", "delegate", "Audit packages/connectors", "c2", "a1"),
    b.subagentStarted("sub-3", "delegate", "Audit apps/updater", "c3", "a1"),
    ...b.toolCall("sub-1:t1", "ls", "", { path: "packages/agent" }, { subagentRunId: "sub-1" }),
    b.toolResult("sub-1:t1", { text: "src\npackage.json" }, { subagentRunId: "sub-1" }),
    ...b.text("sub-1:final", "assistant", "No issues.", { subagentRunId: "sub-1" }),
    b.subagentFinished("sub-1", "No issues."),
    ...b.toolCall("sub-2:t1", "read", "", { path: "packages/connectors/src/index.ts" }, { subagentRunId: "sub-2" }),
    b.subagentError("sub-3", "Stopped at its limit"),
  ]);

const sessionSandboxRefused = (): RelayEvent[] => {
  const d = b.descriptor(
    {
      type: "sandbox_denied",
      command: "npm install left-pad",
      denials: [
        { kind: "write", path: "/Users/me/.npm/_cacache" },
        { kind: "host", host: "registry.npmjs.org", port: 443 },
      ],
      note: "It installs a package into the global cache.",
      tool: { id: "c1", name: "bash", type: "bash", input: {} },
      displayName: "Run command",
    } as never,
    { id: "p1", toolCallId: "c1", runId: "r1", allowed: ["accept", "reject", "allowAlways", "accept_with_message", "reject_with_message"] }
  );
  return seqd([
    ...b.sessionReady("inc-1", "AUTO"),
    ...userTurn("r1", "u1", "Add left-pad", at(1)),
    b.textStart("a1"),
    ...b.toolCall("c1", "bash", "a1", { command: "npm install left-pad" }),
    ...b.permissionEvents([d], d),
  ]);
};

const permission = (request: Record<string, unknown>, toolName: string, input: Record<string, unknown>, mode = "DEFAULT", allowed?: string[]) => (): RelayEvent[] => {
  const d = b.descriptor(
    { ...request, tool: { id: "c1", name: toolName, type: toolName, input }, displayName: toolName } as never,
    { id: "p1", toolCallId: "c1", runId: "r1", ...(allowed != null ? { allowed } : {}) }
  );
  return seqd([
    ...b.sessionReady("inc-1", mode),
    ...userTurn("r1", "u1", "Go ahead", at(1)),
    b.textStart("a1"),
    ...b.toolCall("c1", toolName, "a1", input),
    ...b.permissionEvents([d], d),
  ]);
};

const SANDBOX = ["accept", "accept_with_message", "background", "allowAlways", "allow_always_with_rule", "allow_always_with_rules", "allowYolo", "reject", "reject_with_message"];

const twoPermissions = (): RelayEvent[] => {
  const d1 = b.descriptor(
    { type: "run_terminal", command: "git push origin fix/sidebar-restore", cwd: "/repo", background: false, tool: { id: "c1", name: "bash", type: "bash", input: {} }, displayName: "Run" } as never,
    { id: "p1", toolCallId: "c1", allowed: SANDBOX }
  );
  const d2 = b.descriptor(
    { type: "edit_file", filePath: "src/workspace-view.tsx", originalContent: "a\nb", newContent: "a\nc", tool: { id: "c2", name: "edit", type: "edit", input: {} }, displayName: "Edit" } as never,
    { id: "p2", toolCallId: "c2" }
  );
  return seqd([
    ...b.sessionReady("inc-1", "DEFAULT"),
    ...userTurn("r1", "u1", "Ship it", at(1)),
    b.textStart("a1"),
    ...b.toolCall("c1", "bash", "a1", { command: "git push origin fix/sidebar-restore" }),
    ...b.toolCall("c2", "edit", "a1", { path: "src/workspace-view.tsx" }),
    ...b.permissionEvents([d1, d2]),
  ]);
};

const idleSession = (mode = "DEFAULT") => (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", mode),
    ...userTurn("r1", "u1", "Why does the split view fold at 900?", at(20)),
    ...b.text("a1", "assistant", "It folds when both panes would drop below their 360 px minimum."),
    b.runFinished("r1"),
  ]);

const empty = (): RelayEvent[] => seqd(b.sessionReady("inc-1", "DEFAULT"));

const fromGolden = (name: string) => () => golden(name);

const migratedHistory = (): UIMessage[] => {
  const raw = import.meta.glob<unknown>("../../../../shared/transcript/__fixtures__/v1/*.json", {
    import: "default",
    eager: true,
  });
  return Object.entries(raw).flatMap(([path, file]) => {
    const name = /([^/]+)\.json$/.exec(path)![1]!;
    const segments = Array.isArray(file) ? file : ((file as { segments?: unknown[] }).segments ?? []);
    return v1ToUiMessages(segments).map((message) => ({ ...message, id: `${name}:${message.id}` }));
  });
};

export const SCENARIOS: Scenario[] = [
  { id: "bot-chat", canvas: ["BotChat"], skin: "bot", events: botChat },
  { id: "bot-chat-scrolled", canvas: ["BotChatScrolled"], skin: "bot", events: botUnread },
  { id: "bot-approval-inline", canvas: ["BotApproval"], skin: "bot", events: botApproval },
  { id: "bot-typing", canvas: ["BotChatPanel"], skin: "bot", events: botTyping },
  { id: "bot-unread-marker", canvas: ["BotChannel"], skin: "bot", events: botUnread },
  { id: "bot-banners", canvas: ["BotStates"], skin: "bot", events: botBanners },
  { id: "bot-model-chip", canvas: ["BotDetails"], skin: "bot", events: idleSession("YOLO"), view: { model: "RouteLLM" } },
  { id: "bot-golden-plain", canvas: [], skin: "bot", events: fromGolden("plain-text"), reply: "Hello again." },
  { id: "bot-golden-housekeeping", canvas: [], skin: "bot", events: fromGolden("bot-housekeeping") },
  { id: "session-running", canvas: ["SessionRunning"], skin: "session", events: sessionRunning, view: { model: "RouteLLM" } },
  { id: "session-new", canvas: ["Main", "MainCollapsed"], skin: "session", events: empty, view: { preStart: true, placeholder: "Describe the work", model: "RouteLLM" } },
  { id: "session-mini", canvas: ["FullView"], skin: "session", events: idleSession() },
  { id: "session-mini-focused", canvas: ["FullViewFocused"], skin: "session", events: idleSession() },
  { id: "session-split", canvas: ["SplitView"], skin: "session", events: idleSession() },
  { id: "session-subagents", canvas: ["SubAgents"], skin: "session", events: sessionSubagents },
  { id: "session-failed-ratelimit", canvas: ["SessionFailed"], skin: "session", events: sessionFailedRateLimit, view: { model: "Claude Sonnet" } },
  { id: "session-sandbox-refused", canvas: ["SessionBrowser"], skin: "session", events: sessionSandboxRefused },
  { id: "session-browser", canvas: [], skin: "session", events: permission({ type: "browser_action", action: "click", url: "https://example.com/login", description: "Click “Sign in” on example.com" }, "browser_click", { url: "https://example.com/login" }, "DEFAULT", ["accept", "reject"]) },
  { id: "session-review", canvas: ["SessionReview"], skin: "session", events: sessionReview },
  { id: "session-workspace-missing", canvas: ["SessionWorkspaceMissing"], skin: "session", events: idleSession(), view: { readOnly: "Can't send: ~/code/abacusai-bot no longer exists." } },
  { id: "session-golden-tool-bash", canvas: [], skin: "session", events: fromGolden("tool-bash") },
  { id: "session-golden-delegates", canvas: [], skin: "session", events: fromGolden("delegate-colliding-ids") },
  { id: "session-golden-permission", canvas: [], skin: "session", events: fromGolden("permission-two-calls") },
  { id: "session-golden-plan", canvas: [], skin: "session", events: fromGolden("todo-plan") },
  { id: "session-golden-turn-failed", canvas: [], skin: "session", events: fromGolden("turn-failed") },
  { id: "session-golden-steer", canvas: [], skin: "session", events: fromGolden("steer-and-queue") },
  { id: "session-migrated", canvas: [], skin: "session", events: empty, history: migratedHistory },
  { id: "composer-bot-resting", canvas: ["ComposerStates"], skin: "bot", events: idleSession("YOLO") },
  { id: "composer-session-resting", canvas: ["ComposerStates"], skin: "session", events: idleSession(), view: { model: "RouteLLM" } },
  { id: "composer-bot-queue", canvas: ["ComposerStates"], skin: "bot", events: botQueue },
  { id: "composer-mode-open", canvas: ["ComposerStates"], skin: "session", events: idleSession(), view: { model: "RouteLLM" } },
  { id: "composer-model-open", canvas: ["ComposerStates", "Pickers"], skin: "session", events: idleSession(), view: { model: "RouteLLM" } },
  { id: "perm-run-command", canvas: ["PermissionStates"], skin: "session", events: permission({ type: "run_terminal", command: "git push origin fix/sidebar-restore", cwd: "/Users/me/code/abacusai-bot", background: false }, "bash", { command: "git push origin fix/sidebar-restore" }, "DEFAULT", SANDBOX) },
  { id: "perm-credentials", canvas: ["PermissionStates"], skin: "session", events: permission({ type: "run_terminal", command: "cat ~/.npmrc", cwd: "/repo", background: false, credentialPaths: ["~/.npmrc"] }, "bash", { command: "cat ~/.npmrc" }, "DEFAULT", SANDBOX) },
  { id: "perm-edit-file", canvas: ["PermissionStates"], skin: "session", events: permission({ type: "edit_file", filePath: "src/workspace-view.tsx", originalContent: "mainArea: centerSize - restoredSize,", newContent: "mainArea: centerSize - fromCenter,\n[oppositeId]: oppositeSize - fromOpposite," }, "edit", { path: "src/workspace-view.tsx" }) },
  { id: "perm-network-host", canvas: ["PermissionStates"], skin: "session", events: permission({ type: "network_host", host: "registry.npmjs.org", port: 443 }, "bash", { command: "npm install" }, "AUTO", SANDBOX) },
  { id: "perm-exit-plan", canvas: ["PermissionStates"], skin: "session", events: permission({ type: "exit_plan_mode", planFilePath: "plan.md", planContent: "1. Take the width from the centre first\n2. Take the rest from the opposite panel\n3. Add a test for the full-width case" }, "exit_plan_mode", {}, "PLAN") },
  { id: "perm-question", canvas: ["PermissionStates"], skin: "session", events: permission({ type: "ask_user_question", questions: [ { question: "Which breakpoint should fold split view?", header: "Breakpoint", multiSelect: false, options: [ { label: "960", description: "matching the current compact mode" }, { label: "768", description: "matching the sidebar" }, { label: "Something else", description: "" } ] }, { question: "Keep the old setting?", header: "Setting", multiSelect: true, options: [ { label: "Yes", description: "" }, { label: "No", description: "" } ] } ] }, "ask_user_question", {}, "DEFAULT", ["question_answers", "reject"]) },
  { id: "perm-two-pending", canvas: [], skin: "session", events: twoPermissions },
  { id: "readonly-telegram", canvas: ["ReadOnlyStates"], skin: "bot", events: idleSession("YOLO"), view: { readOnly: "This chat lives in Telegram. Reply there." } },
  { id: "readonly-answering", canvas: ["ReadOnlyStates"], skin: "bot", events: botTyping, view: { readOnly: "Answering in WhatsApp…" } },
  { id: "readonly-routine-run", canvas: ["ReadOnlyStates"], skin: "session", events: sessionReview, view: { readOnly: "A routine run. Open the routine to change it." } },
  { id: "readonly-folder-gone", canvas: ["ReadOnlyStates"], skin: "session", events: idleSession(), view: { readOnly: "Can't send: ~/code/old no longer exists." } },
];

export const scenarioById = (id: string): Scenario | undefined =>
  SCENARIOS.find((scenario) => scenario.id === id);
