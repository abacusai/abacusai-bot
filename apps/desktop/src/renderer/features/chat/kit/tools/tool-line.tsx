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
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

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
import { useMessageScope } from "../message-scope";
import { selectPermission } from "../permissions/selection";
import {
  diffLines,
  normalizeTool,
  parseUnified,
  toolInput,
  type DiffLine,
  type NormalizedTool,
  type ToolStatus,
} from "./normalize";
import { kindOf, toolMeta, type ToolMeta } from "./tool-meta";

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

const STATUS_CLASS: Record<ToolStatus, string> = {
  running: "text-[var(--chat-status-running)]",
  "needs-you": "text-[var(--chat-status-attention)]",
  done: "text-[var(--chat-status-done)]",
  failed: "text-destructive",
  refused: "text-[var(--chat-status-muted)]",
  stopped: "text-[var(--chat-status-muted)]",
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
  | "generic"
  | "none";

export const expanderFor = (name: string): Expander => {
  if (name === "bash") return "bash";
  if (name === "read" || name === "batch_file_read") return "read";
  if (
    ["write", "edit", "ast_edit", "batch_edit", "notebook_edit"].includes(name)
  )
    return "diff";
  if (name.startsWith("browser")) return "browser";
  if (name === "todo") return "none";
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
  return {
    tool,
    input: toolInput(part, parsePartialJSON),
    needsYou: live.needsYou,
  };
};

export const toolTitle = (
  name: string,
  input: Record<string, unknown>
): string => {
  try {
    return buildToolTitle(name, input);
  } catch {
    return name;
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

const BashBody = ({ tool }: { tool: NormalizedTool }) => {
  const ref = useRef<HTMLPreElement>(null);
  const [following, setFollowing] = useState(true);
  const output = tool.terminal?.output ?? tool.text;
  const lines = output.split("\n");
  const tail = lines.length > 2000 ? lines.slice(-2000).join("\n") : output;
  useEffect(() => {
    const element = ref.current;
    if (element != null && following && tool.status === "running")
      element.scrollTop = element.scrollHeight;
  }, [tail, following, tool.status]);
  return (
    <div className="flex flex-col gap-1.5">
      {tool.terminal?.command != null ? (
        <div className="chat-mono text-xs">{`$ ${tool.terminal.command}`}</div>
      ) : null}
      {tail === "" ? null : (
        <pre
          ref={ref}
          className="chat-terminal"
          onScroll={(event) => {
            const element = event.currentTarget;
            setFollowing(
              element.scrollHeight - element.scrollTop - element.clientHeight <
                8
            );
          }}
        >
          {tail}
        </pre>
      )}
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
  const content = tool.read?.content ?? tool.text;
  const path =
    tool.read?.filePath ??
    (typeof input.path === "string" ? input.path : undefined);
  const shown = content.split("\n").slice(0, 200).join("\n");
  const abs =
    path == null
      ? null
      : path.startsWith("/") ||
          /^[A-Za-z]:[\\/]/.test(path) ||
          workspaceRoot == null
        ? path
        : `${workspaceRoot.replace(/[\\/]+$/, "")}/${path}`;
  return (
    <div className="flex flex-col gap-1.5">
      <pre
        className="chat-terminal"
        dangerouslySetInnerHTML={{
          __html: highlightCode(shown, languageForPath(path)),
        }}
      />
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

const Body = ({
  expander,
  tool,
  input,
  diffKey,
}: {
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
          <div className="chat-mono text-muted-foreground">
            {[input.action, input.url]
              .filter((v) => typeof v === "string")
              .join(" ")}
          </div>
          {tool.text === "" ? null : (
            <pre className="chat-terminal">{tool.text}</pre>
          )}
        </div>
      );
    case "generic":
      return tool.formatted != null ? (
        <Markdown
          content={tool.formatted}
          role="assistant"
          workspaceRoot={workspaceRoot}
        />
      ) : tool.text === "" ? null : (
        <pre className="chat-terminal">{tool.text}</pre>
      );
    case "none":
      return null;
  }
};

const hasBody = (expander: Expander, tool: NormalizedTool): boolean => {
  if (expander === "none") return false;
  if (expander === "bash") return tool.terminal != null || tool.text !== "";
  if (expander === "diff") return tool.diff != null || tool.text !== "";
  return (
    tool.text !== "" ||
    tool.formatted != null ||
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
  const { threadId, skin } = useChatView();
  const [firstSeen] = useState(() => Date.now());
  const scope = useSubagentScope();
  const { tool, input, needsYou } = useNormalizedTool(part, result);
  const expander = fixed ?? expanderFor(part.name);
  const Icon = KIND_ICONS[kindOf(part.name)] ?? Wrench;
  const title = toolTitle(part.name, input);
  const meta = toolMeta(
    part.name,
    input,
    tool,
    tool.status === "running" ? firstSeen : null
  );
  const bodyId = useId();
  const expandable = hasBody(expander, tool);
  const row = (
    <>
      <span
        className={cn("shrink-0", STATUS_CLASS[tool.status])}
        data-status={tool.status}
      >
        {t(STATUS_KEY[tool.status])}
      </span>
      <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      <span
        className={cn(
          "text-foreground min-w-0 truncate",
          tool.status === "running" && "shimmer"
        )}
      >
        {title}
      </span>
      <Meta meta={meta} />
    </>
  );
  return (
    <Collapsible className="chat-tool-line" data-tool={part.name}>
      <div className="text-muted-foreground flex min-h-7 items-center gap-2 font-mono text-xs">
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
      {expandable ? (
        <CollapsibleContent id={bodyId} className="ps-5 pt-1 pb-2">
          <Body
            expander={expander}
            tool={tool}
            input={input}
            diffKey={toolKey(scope, part.id)}
          />
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
};
