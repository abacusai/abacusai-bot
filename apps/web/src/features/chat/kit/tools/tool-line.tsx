/**
 * `ToolLine` (spec 02 §5.4): one mono row per tool call, status word, title,
 * meta and an expander, fed only by `NormalizedTool` (§5.4a). Plus the
 * expanders (bash, diff, read, browser, generic).
 */
import { buildToolTitle } from "@abacus-ai/agent/tool-display";
import {
  parsePartialJSON,
  type ToolCallPart,
  type ToolResultPart,
} from "@tanstack/ai-client";
import {
  Bot,
  ChevronRight,
  FilePen,
  FileText,
  Globe,
  ListChecks,
  LoaderCircle,
  Search,
  Square,
  SquareCheck,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  containmentRootFor,
  resolveWorkspacePath,
} from "#renderer/components/file-preview/paths";
import { messageTime } from "#renderer/lib/bot-turns/gap-stamp";
import { cn } from "#renderer/lib/cn";
import { Button } from "#renderer/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#renderer/ui/collapsible";

import {
  useCodeHighlighter,
  languageForPath,
} from "../../markdown/highlighter";
import { Markdown } from "../../markdown/markdown";
import { useToolWindow } from "../../scroller/row-context";
import { descriptorFor, useHost, useThreadStore } from "../../store/selectors";
import { toolKey } from "../../store/thread-store";
import { formatElapsed, useSeconds } from "../clock";
import { useChatView, useSubagentScope } from "../context";
import { ZoomableImage } from "../image-lightbox";
import { useMessageScope } from "../message-scope";
import { selectPermission } from "../permissions/selection";
import { parseAnsi, tailLines } from "./ansi";
import { AskRecapBody } from "./ask-recap";
import { ComponentTitle } from "./component-title";
import { componentLine } from "./component-tools";
import { formatBytes, parseImageRead, type ImageRead } from "./image-read";
import {
  diffLines,
  humanToolName,
  normalizeTool,
  parseUnified,
  stripLineNumbers,
  todoItems,
  toolInput,
  type DiffLine,
  type NormalizedTool,
  type ToolStatus,
} from "./normalize";
import { kindOf, toolMeta, toolOpenPath, type ToolMeta } from "./tool-meta";

const KIND_ICONS: Record<string, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  delete: FilePen,
  move: FilePen,
  execute: Terminal,
  search: Search,
  fetch: Globe,
  think: Bot,
  switch_mode: ListChecks,
  other: Wrench,
};

/** Done is the plain row; every other state is said by tint, not by a word. */
const ROW_TONE: Record<ToolStatus, string> = {
  running: "",
  "needs-you": "text-[var(--chat-status-attention)]",
  done: "",
  failed: "text-destructive",
  refused: "",
  stopped: "",
};

const STATUS_KEY: Record<ToolStatus, string> = {
  running: "chat.tool.status.running",
  "needs-you": "chat.tool.status.needsYou",
  done: "chat.tool.status.done",
  failed: "chat.tool.status.failed",
  refused: "chat.tool.status.refused",
  stopped: "chat.tool.status.stopped",
};

export type Expander =
  | "bash"
  | "diff"
  | "read"
  | "browser"
  | "todo"
  | "ask"
  | "generic"
  | "none";

export const expanderFor = (name: string): Expander => {
  // The files card restates what it delivered; the input JSON adds nothing.
  if (name === "present_deliverable" || name.endsWith("_present_deliverable"))
    return "none";
  if (name === "bash") return "bash";
  if (name === "read" || name === "batch_file_read") return "read";
  if (
    ["write", "edit", "ast_edit", "batch_edit", "notebook_edit"].includes(name)
  )
    return "diff";
  if (name.startsWith("browser")) return "browser";
  if (name === "todo" || name === "todo_write") return "todo";
  if (name === "ask_user_question") return "ask";
  return "generic";
};

/** Everything a row needs, from the part, its result and the store. */
const useNormalizedTool = (
  part: ToolCallPart,
  result: ToolResultPart | undefined
): {
  tool: NormalizedTool;
  input: Record<string, unknown>;
  needsYou: string | null;
} => {
  const { session } = useChatView();
  const scope = useSubagentScope();
  const key = toolKey(scope, part.id);
  const message = useMessageScope();
  const childActive = useHost(session, (state) =>
    state.subagents.some(
      (child) =>
        child.id === scope &&
        (child.status === "running" || child.status === "suspended")
    )
  );
  const live = useThreadStore(
    session,
    (state) => ({
      output: state.tools.output[key],
      display: state.tools.display[key],
      runActive:
        state.runs.active != null &&
        (scope != null
          ? childActive
          : session.isMessageInActiveRun(message.id)),
      needsYou: descriptorFor(state, scope, part.id)?.id ?? null,
    }),
    (a, b) =>
      a.output === b.output &&
      a.display === b.display &&
      a.runActive === b.runActive &&
      a.needsYou === b.needsYou
  );
  const tool = normalizeTool(
    part,
    result,
    {
      ...(live.output != null ? { output: live.output } : {}),
      ...(live.display != null ? { display: live.display } : {}),
    },
    { runActive: live.runActive, needsYou: live.needsYou != null },
    parsePartialJSON
  );
  const input = toolInput(part, parsePartialJSON);
  // A write whose result carries no diff still shows what it wrote, as an
  // all-add diff.
  const written = typeof input.content === "string" ? input.content : null;
  const shown: NormalizedTool =
    part.name === "write" &&
    tool.diff == null &&
    written != null &&
    tool.status !== "failed" &&
    tool.status !== "refused"
      ? { ...tool, diff: { final: written } }
      : tool;
  return { tool: shown, input, needsYou: live.needsYou };
};

/** A request to another bot reads as what it was ("Asked Planner: …"). */
export const exchangeToolTitle = (
  name: string,
  input: Record<string, unknown>,
  t: (key: string, values: Record<string, string>) => string
): string | null => {
  if (name !== "ask_bot" && name !== "give_task_to_bot") return null;
  const bot = typeof input.bot === "string" ? input.bot : "";
  const raw = name === "ask_bot" ? input.request : input.task;
  const what = (typeof raw === "string" ? raw : "").replace(/\s+/g, " ").trim();
  const gist = what.length > 90 ? `${what.slice(0, 89)}…` : what;
  return t(name === "ask_bot" ? "chat.tool.askBot" : "chat.tool.giveTask", {
    bot,
    what: gist,
  });
};

export const toolTitle = (
  name: string,
  input: Record<string, unknown>
): string => {
  try {
    const title = buildToolTitle(name, input);
    return title === name ? humanToolName(name) : title;
  } catch {
    return humanToolName(name);
  }
};

const Meta = ({ meta }: { meta: ToolMeta }) => {
  const { t } = useTranslation();
  const now = useSeconds(meta?.kind === "elapsed");
  if (meta == null) return null;
  switch (meta.kind) {
    case "changes":
      return (
        <span className="flex gap-1">
          <span className="text-[var(--chat-diff-add-fg)]">
            +{meta.additions}
          </span>
          <span className="text-[var(--chat-diff-del-fg)]">
            -{meta.deletions}
          </span>
        </span>
      );
    case "lines":
      return (
        <span className="text-muted-foreground">
          {t("chat.tool.meta.lines", { from: meta.from, to: meta.to })}
        </span>
      );
    case "matches":
      return (
        <span className="text-muted-foreground">
          {t("chat.tool.meta.matches", { count: meta.count })}
        </span>
      );
    case "elapsed":
      return (
        <span className="text-muted-foreground">
          {formatElapsed(now - meta.since)}
        </span>
      );
    case "todo":
      return (
        <span className="text-muted-foreground">
          {t("chat.tool.todoProgress", { done: meta.done, total: meta.total })}
        </span>
      );
    case "exit":
      return (
        <span className="text-destructive">
          {t("chat.tool.meta.exit", { code: meta.code })}
        </span>
      );
  }
};

const DiffView = ({
  lines,
  lang,
  limit,
}: {
  lines: readonly DiffLine[];
  lang: string;
  limit?: number;
}) => {
  const { t } = useTranslation();
  const highlightCode = useCodeHighlighter();
  const [all, setAll] = useState(false);
  const shown = limit != null && !all ? lines.slice(0, limit) : lines;
  return (
    <div className="flex flex-col gap-1">
      <div className="chat-diff" role="group" aria-label={t("chat.tool.diff")}>
        {shown.map((line, index) => (
          <div
            key={index}
            data-kind={line.kind}
            // Escaped by the highlighter; tokens only.
            dangerouslySetInnerHTML={{
              __html: `${line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}${highlightCode(line.text, lang)}`,
            }}
          />
        ))}
      </div>
      {limit != null && lines.length > limit && !all ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setAll(true)}
        >
          {t("chat.tool.showAll", { count: lines.length })}
        </Button>
      ) : null}
    </div>
  );
};

const linesOfDiff = (diff: NonNullable<NormalizedTool["diff"]>): DiffLine[] =>
  diff.unified != null && diff.original == null
    ? parseUnified(diff.unified)
    : diffLines(
        diff.original == null || diff.original === ""
          ? []
          : diff.original.split("\n"),
        diff.final == null || diff.final === "" ? [] : diff.final.split("\n")
      );

const AnsiText = ({ text }: { text: string }) => (
  <>
    {parseAnsi(text).map((run, index) => (
      <span key={index} style={run.style}>
        {run.text}
      </span>
    ))}
  </>
);

/** The last lines of a still-running command, shown even while collapsed. */
const LivePreview = ({ output }: { output: string }) => {
  const tail = tailLines(output, 4).text;
  return tail === "" ? null : (
    <pre
      className="chat-terminal ms-5.5 mt-1 max-h-16 text-xs"
      data-live-output
      aria-live="off"
    >
      <AnsiText text={tail} />
    </pre>
  );
};

/**
 * A running command's latest output, for the group header while the group is
 * closed (the rows inside unmount, so their own preview is out of reach).
 */
export const RunLiveOutput = ({
  part,
  result,
}: {
  part: ToolCallPart;
  result: ToolResultPart | undefined;
}) => {
  const { tool } = useNormalizedTool(part, result);
  return tool.status === "running" ? (
    <LivePreview output={tool.terminal?.output ?? ""} />
  ) : null;
};

const BashBody = ({ tool }: { tool: NormalizedTool }) => {
  const { t } = useTranslation();
  const ref = useRef<HTMLPreElement>(null);
  const [following, setFollowing] = useState(true);
  const terminalOutput = tool.terminal?.output ?? "";
  const output = terminalOutput !== "" ? terminalOutput : tool.text;
  const { text: tail, hidden } = tailLines(output);
  const running = tool.status === "running";
  useEffect(() => {
    const element = ref.current;
    if (element != null && following && running)
      element.scrollTop = element.scrollHeight;
  }, [tail, following, running]);
  const exitCode = tool.terminal?.exitCode;
  const durationMs = tool.terminal?.durationMs;
  return (
    <div className="flex flex-col gap-1.5">
      {tool.terminal?.command != null ? (
        <div className="chat-mono text-xs">{`$ ${tool.terminal.command}`}</div>
      ) : null}
      {hidden > 0 ? (
        <div className="text-muted-foreground text-xs">
          {t("chat.tool.bashEarlierHidden", { count: hidden })}
        </div>
      ) : null}
      {tail === "" ? (
        running || tool.error != null ? null : (
          <div className="text-muted-foreground chat-mono text-xs">
            {t("chat.tool.bashNoOutput")}
          </div>
        )
      ) : (
        <pre
          ref={ref}
          className="chat-terminal max-h-56"
          onScroll={(event) => {
            const element = event.currentTarget;
            setFollowing(
              element.scrollHeight - element.scrollTop - element.clientHeight <
                8
            );
          }}
        >
          <AnsiText text={tail} />
        </pre>
      )}
      {tool.error != null && tool.error !== "" && tool.error !== output ? (
        <div
          role="alert"
          data-bash-error
          className="text-destructive chat-mono text-xs break-words whitespace-pre-wrap"
        >
          {tool.error}
        </div>
      ) : null}
      {!running && (exitCode != null || durationMs != null) ? (
        <div
          className="chat-mono flex items-center gap-2 text-xs"
          data-bash-footer
        >
          {exitCode != null ? (
            <span
              className={
                exitCode === 0
                  ? "text-[var(--chat-status-done)]"
                  : "text-destructive"
              }
            >
              {t("chat.tool.meta.exit", { code: exitCode })}
            </span>
          ) : null}
          {durationMs != null ? (
            <span className="text-muted-foreground">
              {formatElapsed(durationMs)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const TodoBody = ({ input }: { input: Record<string, unknown> }) => (
  <ul className="flex flex-col gap-0.5">
    {todoItems(input).map((item, index) => (
      <li
        key={index}
        data-status={item.status}
        className="flex items-center gap-2 py-0.5 text-xs"
      >
        {item.status === "completed" ? (
          <SquareCheck
            aria-hidden
            className="size-3 shrink-0 text-[var(--chat-status-done)]"
          />
        ) : item.status === "in_progress" ? (
          <LoaderCircle
            aria-hidden
            className="size-3 shrink-0 text-[var(--chat-status-running)]"
          />
        ) : (
          <Square
            aria-hidden
            className="text-muted-foreground size-3 shrink-0"
          />
        )}
        <span
          className={cn(
            item.status === "completed"
              ? "text-muted-foreground line-through"
              : item.status === "in_progress"
                ? "text-foreground"
                : "text-secondary-foreground"
          )}
        >
          {item.content}
        </span>
      </li>
    ))}
  </ul>
);

const OUTPUT_CAP = 3000;

/** Tool output in a <pre>, cut at 3000 characters behind a "show more". */
const CappedOutput = ({ text }: { text: string }) => {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const cut = !all && text.length > OUTPUT_CAP;
  return (
    <div className="flex flex-col gap-1">
      <pre className="chat-terminal">
        {cut ? `${text.slice(0, OUTPUT_CAP)}\n…` : text}
      </pre>
      {cut ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setAll(true)}
        >
          {t("chat.tool.showMoreOutput", {
            count: text.length - OUTPUT_CAP,
          })}
        </Button>
      ) : null}
    </div>
  );
};

const READ_LINES = 80;

const ImageReadCard = ({ image }: { image: ImageRead }) => {
  const { runtime, workspaceRoot } = useChatView();
  const [thumb, setThumb] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const path = image.filePath;
    runtime.host
      .readImage(path, containmentRootFor(path, workspaceRoot))
      .then((url) => {
        if (!live) return;
        if (url === "") setFailed(true);
        else setThumb(url);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [image.filePath, runtime, workspaceRoot]);
  const name = image.filename || (image.filePath.split(/[\\/]/).at(-1) ?? "");
  const subtitle = [
    image.mimeType,
    image.size > 0 ? formatBytes(image.size) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className="bg-muted/50 flex items-center gap-3 rounded-lg px-2.5 py-2"
      data-image-read
    >
      <div className="bg-muted flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md">
        {thumb != null ? (
          <ZoomableImage
            src={thumb}
            alt={name}
            className="size-12 object-cover"
          />
        ) : (
          <FileText
            aria-hidden
            className={cn(
              "size-4",
              failed ? "text-destructive" : "text-muted-foreground opacity-50"
            )}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs" title={name}>
          {name}
        </div>
        {subtitle === "" ? null : (
          <div className="text-muted-foreground text-xs">{subtitle}</div>
        )}
      </div>
    </div>
  );
};

const ReadBody = ({
  tool,
  input,
}: {
  tool: NormalizedTool;
  input: Record<string, unknown>;
}) => {
  const { t } = useTranslation();
  const { onOpenFile, workspaceRoot } = useChatView();
  const highlightCode = useCodeHighlighter();
  const image = parseImageRead(tool.text);
  if (image != null) return <ImageReadCard image={image} />;
  const raw = tool.read?.content ?? tool.text;
  const stripped = stripLineNumbers(raw);
  const path =
    tool.read?.filePath ??
    (typeof input.path === "string" ? input.path : undefined);
  const lines = stripped.text.split("\n");
  const shown = lines.slice(0, READ_LINES).join("\n");
  const more = lines.length - READ_LINES;
  const start =
    stripped.startLine ??
    tool.read?.startLine ??
    (typeof input.offset === "number" ? input.offset : 1);
  const abs = path == null ? null : resolveWorkspacePath(path, workspaceRoot);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <pre
          className="text-muted-foreground chat-mono shrink-0 py-2.5 text-end text-xs leading-[1.6] select-none"
          aria-hidden
          data-line-numbers
        >
          {lines
            .slice(0, READ_LINES)
            .map((_, index) => start + index)
            .join("\n")}
        </pre>
        <pre
          className="chat-terminal min-w-0 flex-1"
          dangerouslySetInnerHTML={{
            __html: highlightCode(shown, languageForPath(path)),
          }}
        />
      </div>
      {more > 0 ? (
        <div className="text-muted-foreground text-xs">
          {t("chat.tool.readMore", { count: more })}
        </div>
      ) : null}
      {abs != null && onOpenFile != null ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => onOpenFile(abs)}
        >
          {t("chat.tool.openFile")}
        </Button>
      ) : null}
    </div>
  );
};

const BROWSER_ARGS: Array<[string, string]> = [
  ["action", "Action"],
  ["url", "URL"],
  ["ref", "Ref"],
  ["selector", "Selector"],
  ["text", "Text"],
  ["value", "Value"],
  ["key", "Key"],
  ["direction", "Direction"],
  ["url_pattern", "URL Pattern"],
  ["depth", "Depth"],
  ["code", "Code"],
];

/** The browser call's own arguments as label/value pairs (click target, typed text, scope, code...). */
export const browserInputLines = (
  name: string,
  input: Record<string, unknown>
): Array<[string, string]> => {
  const lines: Array<[string, string]> = [];
  for (const [key, label] of BROWSER_ARGS) {
    const raw = input[key];
    if (raw == null || raw === "" || typeof raw === "object") continue;
    // A ref names the target; the selector is only a fallback for it.
    if (key === "selector" && input.ref) continue;
    const value = String(raw);
    lines.push([
      key === "selector" && name.includes("snapshot") ? "Scope" : label,
      key === "code" && value.length > 200 ? `${value.slice(0, 200)}…` : value,
    ]);
  }
  return lines;
};

const Body = ({
  expander,
  tool,
  input,
  diffKey,
  name,
}: {
  name: string;
  diffKey: string;
  expander: Expander;
  tool: NormalizedTool;
  input: Record<string, unknown>;
}): ReactNode => {
  const { workspaceRoot, onOpenDiff } = useChatView();
  const { t } = useTranslation();
  if (tool.error != null && tool.status === "failed" && expander !== "bash")
    return <pre className="chat-terminal text-destructive">{tool.error}</pre>;
  switch (expander) {
    case "bash":
      return <BashBody tool={tool} />;
    case "diff":
      return tool.diff == null ? (
        tool.text === "" ? null : (
          <pre className="chat-terminal">{tool.text}</pre>
        )
      ) : (
        <div>
          <DiffView
            lines={linesOfDiff(tool.diff)}
            lang={languageForPath(
              typeof input.path === "string" ? input.path : undefined
            )}
            limit={linesOfDiff(tool.diff).length > 2000 ? 400 : undefined}
          />
          {onOpenDiff ? (
            <button
              type="button"
              className="text-muted-foreground mt-2 text-xs underline"
              onClick={() =>
                onOpenDiff(String(input.path ?? input.file_path ?? ""), diffKey)
              }
            >
              {t("sessions.changes.full")}
            </button>
          ) : null}
        </div>
      );
    case "read":
      return <ReadBody tool={tool} input={input} />;
    case "browser":
      return (
        <div className="flex flex-col gap-1 text-xs">
          {browserInputLines(name, input).length === 0 ? null : (
            <div
              data-browser-args
              className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs"
            >
              {browserInputLines(name, input).map(([label, value]) => (
                <span key={label}>
                  <span className="text-muted-foreground">{label}: </span>
                  <span className="chat-mono text-secondary-foreground">
                    {value}
                  </span>
                </span>
              ))}
            </div>
          )}
          {tool.text === "" ? null : (
            <pre className="chat-terminal">{tool.text}</pre>
          )}
        </div>
      );
    case "generic":
      return (
        <div className="flex flex-col gap-2">
          {Object.keys(input).length === 0 ? null : (
            <div className="flex flex-col gap-1">
              <div className="text-muted-foreground text-xs">
                {t("chat.tool.inputLabel")}
              </div>
              <pre className="chat-terminal max-h-40">
                {JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}
          {tool.formatted != null ? (
            <Markdown
              content={tool.formatted}
              role="assistant"
              workspaceRoot={workspaceRoot}
            />
          ) : tool.text === "" ? null : (
            <CappedOutput text={tool.text} />
          )}
        </div>
      );
    case "todo":
      return <TodoBody input={input} />;
    case "ask":
      return (
        <AskRecapBody
          input={input}
          resultText={tool.text}
          running={tool.status === "running"}
        />
      );
    case "none":
      return null;
  }
};

const hasBody = (
  expander: Expander,
  tool: NormalizedTool,
  input: Record<string, unknown>
): boolean => {
  if (expander === "none") return false;
  if (expander === "todo") return todoItems(input).length > 0;
  if (expander === "ask") return tool.status !== "running" || tool.text !== "";
  if (expander === "bash") return tool.terminal != null || tool.text !== "";
  if (expander === "diff") return tool.diff != null || tool.text !== "";
  return (
    tool.text !== "" ||
    tool.formatted != null ||
    (expander === "generic" && Object.keys(input).length > 0) ||
    tool.error != null ||
    expander === "browser"
  );
};

export interface ToolLineProps {
  part: ToolCallPart;
  result?: ToolResultPart;
  expander?: Expander;
}

export const ToolLine = (props: ToolLineProps) => {
  const window = useToolWindow();
  const scope = useSubagentScope();
  const index = window?.ids.indexOf(`${scope ?? ""}\0${props.part.id}`) ?? -1;
  if (
    window != null &&
    index >= 0 &&
    (index < window.range.start || index >= window.range.end)
  )
    return null;
  return <MountedToolLine {...props} />;
};
const MountedToolLine = ({ part, result, expander: fixed }: ToolLineProps) => {
  const { t } = useTranslation();
  const { threadId, skin, session, onOpenFile, workspaceRoot, runtime } =
    useChatView();
  const [open, setOpen] = useState(false);
  const message = useMessageScope().message;
  const runStart = useThreadStore(
    session,
    (state) => state.runs.active?.startedAt ?? null
  );
  // Hydration can assign a message's creation time on the client. Prefer the
  // recorded run clock so remounting a live tool cannot restart its timer.
  const firstSeen =
    runStart ?? (message ? (messageTime(message)?.getTime() ?? null) : null);
  const scope = useSubagentScope();
  const { tool, input, needsYou } = useNormalizedTool(part, result);
  const expander = fixed ?? expanderFor(part.name);
  const Icon = KIND_ICONS[kindOf(part.name)] ?? Wrench;
  const title =
    exchangeToolTitle(part.name, input, t) ?? toolTitle(part.name, input);
  // A failed, stopped or refused call must not claim "Built"/"Opened": it
  // falls back to the generic row, whose body carries the error.
  const component =
    tool.status === "failed" ||
    tool.status === "stopped" ||
    tool.status === "refused"
      ? null
      : componentLine(
          part.name,
          input,
          tool.status === "running",
          t,
          tool.text
        );
  const meta = toolMeta(
    part.name,
    input,
    tool,
    tool.status === "running" ? firstSeen : null
  );
  const bodyId = useId();
  const openPath = toolOpenPath(part.name, input, workspaceRoot);
  const expandable =
    component == null &&
    tool.status !== "refused" &&
    hasBody(expander, tool, input);
  const tone = ROW_TONE[tool.status];
  const row = (
    <>
      {tool.status === "done" ? null : (
        <span className="sr-only">{t(STATUS_KEY[tool.status])}</span>
      )}
      <Icon
        aria-hidden
        className={cn("size-3.5 shrink-0", tone || "text-muted-foreground")}
      />
      {component != null ? (
        <ComponentTitle line={component} running={tool.status === "running"} />
      ) : (
        <span
          className={cn(
            "min-w-0 truncate",
            tone || "text-foreground",
            tool.status === "running" && "shimmer"
          )}
        >
          {title}
        </span>
      )}
      <Meta meta={meta} />
    </>
  );
  return (
    <Collapsible
      className="chat-tool-line"
      data-tool={part.name}
      open={open}
      onOpenChange={setOpen}
    >
      <div
        data-status={tool.status}
        className={cn(
          "text-muted-foreground flex min-h-7 items-center gap-2 font-mono text-xs",
          tool.status === "refused" || tool.status === "stopped"
            ? "opacity-60"
            : undefined
        )}
      >
        {expandable ? (
          <CollapsibleTrigger
            aria-controls={bodyId}
            className="group/tool focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 rounded-md text-start outline-none focus-visible:ring-2"
          >
            {row}
            <ChevronRight
              aria-hidden
              className="size-3.5 shrink-0 transition-transform group-data-[panel-open]/tool:rotate-90"
            />
          </CollapsibleTrigger>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">{row}</div>
        )}
        {openPath != null && (onOpenFile != null || part.name === "ls") ? (
          <button
            type="button"
            data-open-path={openPath}
            title={openPath}
            aria-label={t("chat.tool.openPath", { path: openPath })}
            className="focus-visible:ring-ring hover:text-foreground max-w-[40%] shrink-0 truncate rounded-md underline-offset-2 outline-none hover:underline focus-visible:ring-2"
            onClick={() =>
              // A folder is revealed, not opened as a preview tab.
              part.name === "ls"
                ? void runtime.host.showItemInFolder(openPath)
                : onOpenFile?.(openPath)
            }
          >
            {openPath
              .replace(/[\\/]+$/, "")
              .split(/[\\/]/)
              .at(-1) ?? openPath}
          </button>
        ) : null}
        {needsYou != null && skin === "session" ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => selectPermission(threadId, needsYou)}
          >
            {t("chat.tool.show")}
          </Button>
        ) : null}
      </div>
      {!open && tool.status === "running" && expander === "bash" ? (
        <LivePreview output={tool.terminal?.output ?? ""} />
      ) : null}
      {expandable ? (
        <CollapsibleContent id={bodyId} className="ps-5.5 pt-1 pb-1">
          <Body
            expander={expander}
            tool={tool}
            input={input}
            name={part.name}
            diffKey={toolKey(scope, part.id)}
          />
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
};
