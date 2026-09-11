import {
  ChevronDown,
  Eye,
  FileText,
  Globe,
  Hammer,
  Search,
  Square,
  SquareCheck,
  SquarePen,
  Terminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { useEffect, useState, useMemo, type JSX } from "react";

import type { StreamingNestedToolCall } from "#shared/agent-types";

import { useResolveWorkspacePath } from "../../hooks/use-workspace-root";
import i18n from "../../i18n";
import { usePreviewLinkHandler } from "../../providers/preview-link-context";
import { openAbsoluteFileInPreview } from "../../utils/preview-utils";
import { ImageLightbox } from "../common/image-lightbox";
import {
  ansiToHtml,
  formatDurationMs,
  parseBashResult,
  tailLines,
} from "../terminal/terminal-output";
import { Button } from "../ui";
import { CodeDiffFull } from "../workspace/code-diff-full";
import { CodeView } from "../workspace/code-view";
import {
  basename,
  componentOutputPath,
  componentToolBase,
  deliverableItems,
  getFilePath,
  type ComponentToolBase,
} from "./component-tools";
import type { ToolRenderItem, ToolRenderState } from "./render-utils";
import { ShimmerText } from "./shimmer-text";
import { summarizeToolGroup, toolGroupSummaryKind } from "./tool-group-logic";

// ─── Icon + color per tool (actual tool names: lowercase/snake_case) ──────────

// ─── File extension → language + color ───────────────────────────────────────

const EXT_COLOR: Record<string, string> = {
  ts: "text-blue-400",
  tsx: "text-blue-400",
  js: "text-yellow-400",
  jsx: "text-yellow-400",
  mjs: "text-yellow-400",
  json: "text-yellow-300",
  py: "text-green-400",
  css: "text-blue-500",
  scss: "text-pink-400",
  html: "text-orange-400",
  htm: "text-orange-400",
  yaml: "text-red-300",
  yml: "text-red-300",
  rs: "text-orange-400",
  go: "text-cyan-400",
  java: "text-red-400",
  sh: "text-green-400",
  bash: "text-green-400",
  md: "text-blue-300",
};

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  json: "json",
  py: "python",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  yaml: "yaml",
  yml: "yaml",
  rs: "rust",
  go: "go",
  java: "java",
  sh: "bash",
  bash: "bash",
  md: "markdown",
  rb: "ruby",
  php: "php",
  cpp: "cpp",
  c: "c",
  cs: "csharp",
  kt: "kotlin",
  swift: "swift",
  toml: "toml",
  xml: "xml",
  sql: "sql",
};

function extColor(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "text-muted-foreground";
  return (
    EXT_COLOR[filename.slice(dot + 1).toLowerCase()] ?? "text-muted-foreground"
  );
}

function extLang(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "text";
  return EXT_LANG[filename.slice(dot + 1).toLowerCase()] ?? "text";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getFilename(input: Record<string, unknown>): string | null {
  const full = getFilePath(input);
  if (full == null) return null;
  const parts = full.split(/[/\\]/);
  return parts[parts.length - 1] || full;
}

function truncate(s: string, max = 60): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// Label + click target for a component tool call, from its arguments. Returns
// null when the call built nothing (a pdf read, `app` list/serve/stop).
function componentToolLabel(
  base: ComponentToolBase,
  input: Record<string, unknown>,
  running: boolean
): ReturnType<typeof getToolLabel> | null {
  const str = (k: string): string => String(input[k] ?? "").trim();
  const action = str("action");

  if (base === "document") {
    const target = componentOutputPath(base, input);
    const action = running ? "Writing document" : "Wrote document";
    if (target == null) return { action };
    return { action, chip: basename(target), isFile: true, targetPath: target };
  }

  if (base === "pdf" || base === "ppt" || base === "deck_export_pdf") {
    const isReprint = base === "pdf" && action === "reprint";
    const isDeck = base === "ppt";
    const label = isReprint
      ? running
        ? "Printing PDF"
        : "Printed PDF"
      : isDeck
        ? running
          ? "Building deck"
          : "Built deck"
        : running
          ? "Building PDF"
          : "Built PDF";
    const target = componentOutputPath(base, input);
    if (target == null)
      return {
        action: running ? "Working" : "Ran",
        chip: isDeck ? "deck" : "PDF",
      };
    return {
      action: label,
      chip: basename(target),
      isFile: true,
      targetPath: target,
    };
  }

  if (base === "present_deliverable") {
    // The deliverables themselves render as the turn's files card (see
    // deliverables-pill.tsx), so the header stays a plain count.
    const items = deliverableItems(input);
    const action = running
      ? i18n.t("workspace.deliverable.delivering")
      : i18n.t("workspace.deliverable.delivered");
    if (items.length === 0) return { action };
    return {
      action,
      chip: i18n.t("workspace.deliverable.itemCount", { count: items.length }),
    };
  }

  if (base === "design") {
    const target = componentOutputPath(base, input);
    const action = running ? "Designing" : "Designed";
    if (target == null) return { action };
    return {
      action,
      chip: basename(str("output_dir")),
      isFile: true,
      targetPath: target,
    };
  }

  const target = str("path");
  if (target.length === 0)
    return { action: running ? "Opening preview" : "Opened preview" };
  // A served app comes back as a URL, which has no file to open.
  const isUrl = /^https?:\/\//i.test(target);
  return {
    action: running ? "Opening" : "Opened",
    chip: isUrl ? truncate(target, 50) : basename(target),
    ...(isUrl ? {} : { isFile: true, targetPath: target }),
  };
}

// Convert snake_case internal tool name to a human-readable display name
function toolDisplayName(name: string): string {
  if (typeof name !== "string") return "";
  // Drop the MCP server prefix for display only; main and the agent match
  // component tools by the full name.
  const bare = name.startsWith("agent-tools_")
    ? name.slice("agent-tools_".length)
    : name;
  return bare.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Strip CLI-style "  123→ " or "123\t" line prefixes from Read tool output
function stripLineNumberPrefixes(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\s*\d+[→\t]\s?/, ""))
    .join("\n");
}

// Format a byte count as a short human-readable string for tool labels.
function formatToolBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// The CLI's `read` of an uploaded image returns a JSON envelope
// ({"isUploadedDoc":true,"filePath":...,"filename":...,"mimeType":...})

// rather than text. Detect it to render a thumbnail card, not a JSON block.
type ImageReadResult = {
  filePath: string;
  filename: string;
  size: number;
  mimeType: string;
};

function parseImageReadResult(
  rawContent: string | undefined
): ImageReadResult | null {
  if (rawContent == null) return null;
  const trimmed = rawContent.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed == null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "read" || obj.status !== "success") return null;
  const mimeType = typeof obj.mimeType === "string" ? obj.mimeType : "";
  if (!mimeType.startsWith("image/")) return null;
  const filePath = typeof obj.filePath === "string" ? obj.filePath : "";
  const filename = typeof obj.filename === "string" ? obj.filename : "";
  const size = typeof obj.size === "number" ? obj.size : 0;
  if (filePath.length === 0) return null;
  return { filePath, filename, size, mimeType };
}

// ─── Tool label (row header text) ────────────────────────────────────────────

function getToolLabel(tool: ToolRenderItem): {
  action: string;
  chip?: string;
  isFile?: boolean;
  lineInfo?: string;
  /** Absolute path the chip points at, when the chip names something on disk. */
  targetPath?: string;
  /** Reveal in the OS file manager instead of opening in the preview panel. */
  isDirectory?: boolean;
} {
  const inp = tool.input;
  const running = tool.state === "running";
  const str = (k: string) => String(inp[k] ?? "").trim();

  switch (tool.name) {
    case "read": {
      const offset = inp.offset != null ? Number(inp.offset) : undefined;
      const limit = inp.limit != null ? Number(inp.limit) : undefined;
      let lineInfo: string | undefined;
      if (offset !== undefined && limit !== undefined) {
        lineInfo = `lines ${offset}–${offset + limit - 1}`;
      } else if (limit !== undefined) {
        lineInfo = `${limit} lines`;
      }
      let filename = getFilename(inp);
      if (!running && tool.result != null) {
        // An uploaded-image read shows filename + size from the envelope
        // rather than labelling the JSON body "1 lines".
        const imageRead = parseImageReadResult(tool.result.content);
        if (imageRead != null) {
          if (filename == null && imageRead.filename.length > 0)
            filename = imageRead.filename;
          lineInfo =
            imageRead.size > 0 ? formatToolBytes(imageRead.size) : "image";
        } else {
          // The tool result reports its own line count; fall back to counting
          // the returned content only when it doesn't.
          const lc =
            tool.displayData?.lineCount ??
            tool.result.content?.split("\n").length;
          if (lc && lc > 0) lineInfo = `${lc} lines`;
        }
      }
      return {
        action: running ? "Reading" : "Read",
        chip: filename ?? undefined,
        isFile: true,
        lineInfo,
        targetPath: getFilePath(inp) ?? undefined,
      };
    }
    case "write": {
      const filename = getFilename(inp);
      const isNew = tool.displayData?.isNewFile ?? true;
      const content = str("content");
      const lineCount =
        content.length > 0
          ? content.split("\n").length
          : tool.displayData?.newContent?.split("\n").length;
      return {
        action: running
          ? isNew
            ? "Creating"
            : "Writing"
          : isNew
            ? "Created"
            : "Wrote",
        chip: filename ?? undefined,
        isFile: true,
        lineInfo: lineCount != null ? `${lineCount} lines` : undefined,
        targetPath: getFilePath(inp) ?? undefined,
      };
    }
    case "edit":
    case "batch_edit":
    case "notebook_edit": {
      const filename = getFilename(inp);
      const adds = tool.displayData?.additions;
      const dels = tool.displayData?.deletions;
      const diffInfo =
        adds != null || dels != null
          ? [
              adds != null && adds > 0 ? `+${adds}` : null,
              dels != null && dels > 0 ? `-${dels}` : null,
            ]
              .filter(Boolean)
              .join(" ")
          : undefined;
      return {
        action: running ? "Editing" : "Edited",
        chip: filename ?? undefined,
        isFile: true,
        lineInfo: diffInfo,
        targetPath: getFilePath(inp) ?? undefined,
      };
    }
    case "delete":
      return {
        action: running ? "Deleting" : "Deleted",
        chip: getFilename(inp) ?? undefined,
        isFile: true,
      };
    case "bash": {
      const rawCmd = str("command").split("\n")[0];
      const cmd = truncate(rawCmd, 60);
      return {
        action: running ? "Running" : "Ran",
        chip: cmd.length > 0 ? cmd : undefined,
      };
    }
    case "bash_output":
      return { action: running ? "Getting output" : "Got output" };
    case "kill_shell":
      return { action: running ? "Killing shell" : "Killed shell" };
    case "glob":
      return {
        action: running ? "Searching files" : "Searched files",
        chip: str("pattern").slice(0, 50) || undefined,
      };
    case "grep":
      return {
        action: running ? "Searching" : "Searched",
        chip: str("pattern").slice(0, 50) || undefined,
      };
    case "ls":
      return {
        action: running ? "Listing" : "Listed",
        chip: str("path") || ".",
        isFile: true,
        targetPath: str("path") || undefined,
        isDirectory: true,
      };
    case "codebase_search":
      return {
        action: running ? "Searching codebase" : "Searched codebase",
        chip: str("query").slice(0, 50) || undefined,
      };
    case "web_search":
      return {
        action: running ? "Searching web" : "Searched web",
        chip: str("query").slice(0, 50) || undefined,
      };
    case "web_fetch":
      return {
        action: running ? "Fetching" : "Fetched",
        chip: str("url").slice(0, 50) || undefined,
      };
    case "task":
    case "subagent": {
      const desc =
        typeof inp.description === "string"
          ? truncate(inp.description as string, 40)
          : undefined;
      const count =
        tool.displayData?.toolCallCount ??
        tool.displayData?.nestedToolCalls?.length;
      const lineInfo =
        count != null && count > 0
          ? `${count} tool${count !== 1 ? "s" : ""}`
          : undefined;
      return {
        action: running ? "Running sub-agent" : "Used sub-agent",
        chip: desc,
        lineInfo,
      };
    }
    case "todo_write":
      return { action: running ? "Updating todos" : "Updated todos" };
    case "ask_user_question":
      return {
        action: running ? "Asking question" : "Asked question",
        chip:
          typeof inp.question === "string"
            ? truncate(inp.question as string, 50)
            : undefined,
      };
    case "enter_plan_mode":
      return { action: running ? "Entering plan mode" : "Entered plan mode" };
    case "exit_plan_mode":
      return { action: running ? "Exiting plan mode" : "Exited plan mode" };
    case "get_diagnostics":
      return {
        action: running ? "Getting diagnostics" : "Got diagnostics",
        chip: getFilename(inp) ?? undefined,
        isFile: true,
      };
    case "browser_navigate": {
      const action_nav = str("action");
      const navLabels: Record<string, [string, string]> = {
        goto: ["Navigating to", "Navigated to"],
        back: ["Going back", "Went back"],
        forward: ["Going forward", "Went forward"],
        reload: ["Reloading page", "Reloaded page"],
      };
      const [runLabel, doneLabel] = navLabels[action_nav] ?? [
        "Navigating",
        "Navigated",
      ];
      return {
        action: running ? runLabel : doneLabel,
        chip:
          action_nav === "goto"
            ? str("url").slice(0, 60) || undefined
            : undefined,
      };
    }
    case "browser_snapshot": {
      const action_snap = str("action");
      const snapLabels: Record<string, [string, string]> = {
        snapshot: ["Scanning page", "Scanned page"],
        screenshot: ["Taking screenshot", "Took screenshot"],
        text: ["Getting page text", "Got page text"],
        url: ["Getting page URL", "Got page URL"],
        title: ["Getting page title", "Got page title"],
      };
      const [runLabel, doneLabel] = snapLabels[action_snap] ?? [
        "Capturing snapshot",
        "Captured snapshot",
      ];
      const scopeChip =
        action_snap === "snapshot" && str("selector")
          ? str("selector").slice(0, 40)
          : undefined;
      return { action: running ? runLabel : doneLabel, chip: scopeChip };
    }
    case "browser_interact": {
      const action_int = str("action");
      const intLabels: Record<string, [string, string]> = {
        click: ["Clicking", "Clicked"],
        fill: ["Filling", "Filled"],
        type: ["Typing", "Typed"],
        scroll: ["Scrolling", "Scrolled"],
        scroll_into_view: ["Scrolling to", "Scrolled to"],
        select: ["Selecting option", "Selected option"],
        hover: ["Hovering", "Hovered"],
        focus: ["Focusing", "Focused"],
        check: ["Checking", "Checked"],
        uncheck: ["Unchecking", "Unchecked"],
        press: ["Pressing", "Pressed"],
        wait: ["Waiting", "Waited"],
      };
      const [runLabel, doneLabel] = intLabels[action_int] ?? [
        "Interacting",
        "Interacted",
      ];
      const target =
        str("ref").slice(0, 20) ||
        str("selector").slice(0, 40) ||
        str("key") ||
        undefined;
      return { action: running ? runLabel : doneLabel, chip: target };
    }
    case "browser_execute": {
      const snippet = str("code").split("\n")[0]?.slice(0, 50);
      return {
        action: running ? "Executing JS" : "Executed JS",
        chip: snippet || undefined,
      };
    }
    default: {
      const component = componentToolBase(tool.name);
      if (component != null) {
        const label = componentToolLabel(component, inp, running);
        if (label != null) return label;
      }
      return {
        action: running ? "Running" : "Ran",
        chip: toolDisplayName(tool.name),
      };
    }
  }
}

// ─── Group summary ────────────────────────────────────────────────────────────

/**
 * The one line a tool group shows until opened: a count by category ("Ran 1
 * command", "Edited 2 files"), never the command or file name, which makes a
 * transcript read like a build log.
 */
// ─── Chip ─────────────────────────────────────────────────────────────────────

const ToolChip = ({
  text,
  isFile,
  additions,
  deletions,
  targetPath,
  isDirectory,
}: {
  text: string;
  isFile?: boolean;
  additions?: number | null;
  deletions?: number | null;
  targetPath?: string;
  isDirectory?: boolean;
}): JSX.Element => {
  const fileColor = isFile ? extColor(text) : "";
  const openPreview = usePreviewLinkHandler();
  const resolvePath = useResolveWorkspacePath();
  // A chip that names something on disk is a link: files open in the Files
  // (preview) panel, directories are revealed in the OS file manager.
  const canOpen = targetPath != null && targetPath.length > 0;
  const open = (): void => {
    if (!canOpen) return;
    // Resolve first — a workspace-relative path would otherwise fail the file
    // read inside the preview opener and fall through to the OS-level opener.
    const absolute = resolvePath(targetPath);
    if (isDirectory === true) {
      void window.api.showItemInFolder(absolute);
      return;
    }
    if (openPreview != null) openPreview(absolute);
    else void openAbsoluteFileInPreview(absolute);
  };
  const Tag = canOpen ? "button" : "span";
  return (
    <Tag
      {...(canOpen
        ? {
            type: "button" as const,
            onClick: open,
            title: targetPath,
            "data-id": "local-code-tool-chip-open",
          }
        : {})}
      className={`border-border inline-flex max-w-55 shrink-0 items-center gap-0.5 truncate rounded border px-1.5 font-mono text-xs leading-5 ${fileColor || "text-muted-foreground"} ${canOpen ? "hover:bg-accent hover:border-primary/50 cursor-pointer transition-colors" : ""}`}
    >
      {isFile && (
        <svg
          className="h-2.5 w-2.5 shrink-0 opacity-60"
          viewBox="0 0 12 12"
          fill="none"
        >
          <path d="M2 1h5l3 3v7H2V1z" stroke="currentColor" strokeWidth="1" />
          <path d="M7 1v3h3" stroke="currentColor" strokeWidth="1" />
        </svg>
      )}
      <span className="truncate">{text}</span>
      {additions != null && additions > 0 && (
        <span className="pl-0.5 text-green-400">+{additions}</span>
      )}
      {deletions != null && deletions > 0 && (
        <span className="text-red-400">-{deletions}</span>
      )}
    </Tag>
  );
};

// ─── TodoWrite expanded view ──────────────────────────────────────────────────

const TodoInProgressIcon = (): JSX.Element => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 11 11"
    fill="none"
    className="shrink-0 text-blue-400"
  >
    <rect
      x="0.75"
      y="0.75"
      width="9.5"
      height="9.5"
      rx="2"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeDasharray="2.5 1.8"
    />
    <circle cx="5.5" cy="5.5" r="1.75" fill="currentColor" />
  </svg>
);

const TodoList = ({
  input,
}: {
  input: Record<string, unknown>;
}): JSX.Element | null => {
  const todos = Array.isArray(input.todos) ? input.todos : null;
  if (todos == null || todos.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-0.5">
      {todos.map((item: any, idx: number) => (
        <div
          key={item?.id ?? idx}
          className="flex items-center gap-2 py-0.5 text-xs"
        >
          {item?.status === "completed" ? (
            <SquareCheck className="size-3 shrink-0 text-green-500" />
          ) : item?.status === "in_progress" ? (
            <TodoInProgressIcon />
          ) : (
            <Square className="text-muted-foreground size-3 shrink-0" />
          )}
          <span
            className={
              item?.status === "completed"
                ? "text-muted-foreground line-through"
                : item?.status === "in_progress"
                  ? "text-foreground"
                  : "text-secondary-foreground"
            }
          >
            {item?.content ?? "Task"}
          </span>
        </div>
      ))}
    </div>
  );
};

// ─── Bash terminal output ─────────────────────────────────────────────────────

const BashOutput = ({ tool }: { tool: ToolRenderItem }): JSX.Element => {
  const raw =
    tool.result?.content ??
    tool.liveOutput ??
    tool.displayData?.streamingOutput ??
    "";
  const { output, exitCode, durationMs } = parseBashResult(raw);
  const MAX_LINES = 300;

  const { html, hiddenLines } = useMemo(() => {
    if (output.length === 0) return { html: "", hiddenLines: 0 };
    const { shown, hidden } = tailLines(output, MAX_LINES);
    return { html: ansiToHtml(shown), hiddenLines: hidden };
  }, [output]);

  const isError = exitCode != null && exitCode !== 0;

  if (output.length === 0) {
    return (
      <div className="text-muted-foreground px-1 py-0.5 text-xs italic">
        (no output)
      </div>
    );
  }

  return (
    <div className="border-border bg-bg-terminal overflow-hidden rounded border">
      {/* Exit code + duration bar */}
      {(exitCode != null || durationMs != null) && (
        <div className="flex items-center gap-2 border-b border-white/10 bg-white/5 px-2 py-0.5">
          {exitCode != null && (
            <span
              className={`font-mono text-[0.625rem] ${isError ? "text-red-400" : "text-green-400"}`}
            >
              exit {exitCode}
            </span>
          )}
          {durationMs != null && (
            <span className="text-text-terminal/60 font-mono text-[0.625rem]">
              {formatDurationMs(durationMs)}
            </span>
          )}
        </div>
      )}
      {hiddenLines > 0 && (
        <div className="text-text-terminal/60 border-b border-white/10 px-2 py-1 text-[0.625rem] italic">
          … {hiddenLines} earlier lines hidden
        </div>
      )}
      {/* ANSI output */}
      <div
        className="text-text-terminal max-h-55 overflow-x-auto overflow-y-auto px-2 py-1.5 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
};

// ─── Read file expanded view ──────────────────────────────────────────────────

const ImageReadCard = ({ image }: { image: ImageReadResult }): JSX.Element => {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const ReadIcon = loadError ? TriangleAlert : FileText;

  useEffect(() => {
    let cancelled = false;
    const lastSlash = image.filePath.lastIndexOf("/");
    const hostRoot =
      lastSlash > 0 ? image.filePath.slice(0, lastSlash) : image.filePath;
    void window.api.files
      .readImageAsDataUrl({ filePath: image.filePath, hostRoot })
      .then((res) => {
        if (cancelled) return;
        if (res?.success === true && res.dataUrl != null) {
          setDataUrl(res.dataUrl);
        } else {
          setLoadError(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [image.filePath]);

  const sizeLabel = image.size > 0 ? formatToolBytes(image.size) : "";
  const subtitle = [image.mimeType, sizeLabel].filter(Boolean).join(" · ");

  return (
    <>
      <div className="border-border bg-muted/50 mt-0.5 flex items-center gap-3 rounded-lg border px-2.5 py-2">
        <Button
          variant="ghost"
          onClick={() => {
            if (dataUrl != null) setLightboxOpen(true);
          }}
          disabled={dataUrl == null}
          className="border-border bg-muted size-12 shrink-0 overflow-hidden rounded-md p-0 disabled:cursor-not-allowed"
          data-id="local-code-tool-image-thumb"
          title={image.filename}
        >
          {dataUrl != null ? (
            <img
              src={dataUrl}
              alt={image.filename}
              className="h-full w-full object-cover"
            />
          ) : (
            <ReadIcon
              className={`size-3.5 ${loadError ? "text-amber-400" : "text-muted-foreground opacity-50"}`}
            />
          )}
        </Button>
        <div className="min-w-0 flex-1">
          <div
            className="text-foreground truncate text-xs"
            title={image.filename}
          >
            {image.filename}
          </div>
          {subtitle.length > 0 && (
            <div className="text-muted-foreground text-[0.625rem]">
              {subtitle}
            </div>
          )}
        </div>
      </div>
      <ImageLightbox
        isOpen={lightboxOpen}
        imageUrl={dataUrl ?? ""}
        onClose={() => setLightboxOpen(false)}
      />
    </>
  );
};

const ReadFileExpand = ({ tool }: { tool: ToolRenderItem }): JSX.Element => {
  const filepath = getFilePath(tool.input) ?? "";
  const rawContent = tool.result?.content ?? "";

  // An uploaded-image read renders as a thumbnail card, not a JSON block.
  const imageRead = parseImageReadResult(rawContent);
  if (imageRead != null) {
    return <ImageReadCard image={imageRead} />;
  }

  const content = stripLineNumberPrefixes(rawContent).trimEnd();
  const lang = filepath ? extLang(filepath) : "text";
  const offset =
    tool.input.offset != null ? Number(tool.input.offset) : undefined;

  if (content.length === 0) {
    return (
      <div className="text-muted-foreground px-1 py-0.5 text-xs italic">
        (no content)
      </div>
    );
  }

  const lines = content.split("\n");
  const MAX = 80;
  const shown = lines.slice(0, MAX).join("\n");
  const hidden = lines.length - MAX;

  return (
    <div className="border-border mt-0.5 max-h-70 overflow-y-auto rounded border">
      <CodeView code={shown} language={lang} startingLineNumber={offset ?? 1} />
      {hidden > 0 && (
        <div className="text-muted-foreground bg-muted border-border border-t px-2 py-1 text-xs italic">
          … +{hidden} more lines
        </div>
      )}
    </div>
  );
};

// ─── Write/Edit diff or code expanded view ────────────────────────────────────

const WriteEditExpand = ({ tool }: { tool: ToolRenderItem }): JSX.Element => {
  const filepath = getFilePath(tool.input) ?? "";
  const isNew = tool.displayData?.isNewFile ?? false;
  const originalContent = tool.displayData?.originalContent ?? "";
  const newContent =
    tool.displayData?.finalContent ??
    tool.displayData?.newContent ??
    String(tool.input.content ?? tool.input.newString ?? "");

  if (newContent.length === 0) {
    return (
      <div className="text-muted-foreground px-1 py-0.5 text-xs italic">
        (no content available)
      </div>
    );
  }

  if (isNew || originalContent.length === 0) {
    const lang = filepath ? extLang(filepath) : "text";
    const lines = newContent.split("\n");
    const MAX = 80;
    const shown = lines.slice(0, MAX).join("\n");
    const hidden = lines.length - MAX;
    return (
      <div className="border-border mt-0.5 max-h-70 overflow-y-auto rounded border">
        <CodeView code={shown} language={lang} />
        {hidden > 0 && (
          <div className="text-muted-foreground bg-muted border-border border-t px-2 py-1 text-xs italic">
            … +{hidden} more lines
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-0.5">
      <CodeDiffFull
        oldCode={originalContent}
        newCode={newContent}
        maxHeight={280}
        allowScroll
      />
    </div>
  );
};

// ─── Generic fallback expanded view ──────────────────────────────────────────

const GenericExpand = ({ tool }: { tool: ToolRenderItem }): JSX.Element => {
  const inputStr = (() => {
    const filtered = Object.fromEntries(
      Object.entries(tool.input).filter(([k]) => !k.startsWith("_"))
    );
    try {
      return JSON.stringify(filtered, null, 2);
    } catch {
      return String(tool.input);
    }
  })();
  const outputStr = (tool.result?.content ?? "").trim().slice(0, 3000);

  return (
    <div className="border-border mt-1 overflow-hidden rounded-lg border text-xs">
      <div className="px-2 py-1.5">
        <div className="text-muted-foreground mb-1 text-[0.625rem] font-semibold tracking-wider uppercase">
          Input
        </div>
        <pre className="text-foreground bg-muted border-border max-h-25 overflow-y-auto rounded border p-1.5 font-mono leading-relaxed break-all whitespace-pre-wrap">
          {inputStr}
        </pre>
      </div>
      {outputStr.length > 0 && (
        <div className="border-border border-t px-2 py-1.5">
          <div className="text-muted-foreground mb-1 text-[0.625rem] font-semibold tracking-wider uppercase">
            Output
          </div>
          <pre className="text-foreground bg-muted border-border max-h-25 overflow-y-auto rounded border p-1.5 font-mono leading-relaxed break-all whitespace-pre-wrap">
            {outputStr}
          </pre>
        </div>
      )}
    </div>
  );
};

// ─── AskUserQuestion completed view ──────────────────────────────────────────

interface QuestionItem {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

const AskUserQuestionExpand = ({
  tool,
}: {
  tool: ToolRenderItem;
}): JSX.Element => {
  const questions: QuestionItem[] = Array.isArray(tool.input.questions)
    ? (tool.input.questions as QuestionItem[])
    : [];

  // Answers come from tool input (merged by agent on completion) or from result JSON
  let answers: Record<string, string> = {};
  if (typeof tool.input.answers === "object" && tool.input.answers !== null) {
    answers = tool.input.answers as Record<string, string>;
  } else if (tool.result?.content) {
    try {
      const parsed = JSON.parse(tool.result.content);
      if (parsed?.answers && typeof parsed.answers === "object") {
        answers = parsed.answers;
      }
    } catch {}
  }

  const isWaiting =
    tool.state === "running" && Object.keys(answers).length === 0;
  if (isWaiting) {
    return (
      <div className="text-muted-foreground px-1 py-0.5 text-xs italic">
        Waiting for response…
      </div>
    );
  }

  if (questions.length === 0 && Object.keys(answers).length === 0) {
    return (
      <div className="text-muted-foreground px-1 py-0.5 text-xs italic">
        (no questions)
      </div>
    );
  }

  // Show Q&A pairs
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {questions.map((q, i) => {
        const answer = answers[`question_${i}`];
        const parts = answer?.split(" — ");
        const selection = parts?.[0];
        const note =
          parts && parts.length > 1 ? parts.slice(1).join(" — ") : undefined;
        return (
          <div key={i} className="flex flex-col gap-0.5">
            <div className="text-muted-foreground text-xs">{q.header}</div>
            {answer != null ? (
              <div className="flex flex-col gap-0.5">
                <div className="text-foreground flex items-center gap-1 text-xs">
                  <span className="text-[0.625rem] text-green-400">→</span>
                  <span>{selection}</span>
                </div>
                {note != null && (
                  <div className="text-muted-foreground ml-3 text-xs italic">
                    {note}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-muted-foreground ml-3 text-xs italic">
                Skipped
              </div>
            )}
          </div>
        );
      })}
      {/* If no structured questions but raw answers */}
      {questions.length === 0 && Object.keys(answers).length > 0 && (
        <pre className="text-muted-foreground bg-muted rounded p-1.5 font-mono text-xs whitespace-pre-wrap">
          {JSON.stringify(answers, null, 2)}
        </pre>
      )}
    </div>
  );
};

// ─── Task / Subagent nested tool expand ──────────────────────────────────────

interface TaskResult {
  toolCalls?: Array<{
    name: string;
    input: Record<string, unknown>;
    result?: string;
  }>;
  error?: string;
}

function nestedCallState(c: {
  status?: string;
  result?: string;
}): ToolRenderState {
  if (c.status === "executing") return "running";
  if (c.status === "error") return "error";
  if (c.result) {
    if (c.result.startsWith("Error:")) return "error";
    try {
      const p = JSON.parse(c.result);
      if (
        p.status === "error" ||
        (typeof p.exitCode === "number" && p.exitCode !== 0)
      )
        return "error";
    } catch {}
  }
  return "done";
}

function streamingToRenderItem(
  c: StreamingNestedToolCall,
  i: number
): ToolRenderItem {
  return {
    id: c.id ?? `nested-${i}`,
    name: c.name,
    input: c.input ?? {},
    state: nestedCallState({ status: c.status }),
    streamingArgs: false,
  };
}

const EMPTY_NESTED_TOOL_CALLS: StreamingNestedToolCall[] = [];

const TaskSubagentExpand = ({
  tool,
}: {
  tool: ToolRenderItem;
}): JSX.Element => {
  const nestedCalls: StreamingNestedToolCall[] =
    tool.displayData?.nestedToolCalls ?? EMPTY_NESTED_TOOL_CALLS;
  const resultContent = tool.result?.content;
  const resultData = useMemo((): TaskResult | null => {
    if (!resultContent) return null;
    try {
      return JSON.parse(resultContent) as TaskResult;
    } catch {
      return null;
    }
  }, [resultContent]);

  const items: ToolRenderItem[] = useMemo(() => {
    if (nestedCalls.length > 0) {
      return nestedCalls.map(streamingToRenderItem);
    }
    if (resultData?.toolCalls && resultData.toolCalls.length > 0) {
      return resultData.toolCalls.map((c, i) => ({
        id: `result-nested-${i}`,
        name: c.name,
        input: c.input ?? {},
        state: nestedCallState({ result: c.result }),
        result: c.result != null ? { content: c.result } : undefined,
        streamingArgs: false,
      }));
    }
    return [];
  }, [nestedCalls, resultData]);

  const isRunning = tool.state === "running";

  if (items.length === 0) {
    return (
      <div className="text-muted-foreground py-0.5 text-xs italic">
        {isRunning ? "Running sub-agent…" : "(no tool calls recorded)"}
      </div>
    );
  }

  return (
    <div className="flex max-h-80 flex-col overflow-y-auto">
      {items.map((t, i) => (
        <ToolRow
          key={`${t.id}-${i}`}
          tool={t}
          isFirst={i === 0}
          isLast={i === items.length - 1}
          nested
        />
      ))}
      {resultData?.error != null && (
        <div className="px-1 pt-0.5 text-xs text-red-400">
          {resultData.error}
        </div>
      )}
    </div>
  );
};

// ─── Browser MCP expand ──────────────────────────────────────────────────────

const BrowserToolExpand = ({ tool }: { tool: ToolRenderItem }): JSX.Element => {
  const inp = tool.input;
  const resultContent = tool.result?.content ?? tool.liveOutput ?? "";
  const isRunning = tool.state === "running";

  const actionStr = String(inp.action ?? "").trim();

  const inputLines: Array<[string, string]> = [];
  if (actionStr) inputLines.push(["Action", actionStr]);
  if (tool.name === "browser_navigate" && inp.url)
    inputLines.push(["URL", String(inp.url)]);
  if (tool.name === "browser_interact") {
    if (inp.ref) inputLines.push(["Ref", String(inp.ref)]);
    else if (inp.selector) inputLines.push(["Selector", String(inp.selector)]);
    if (inp.text) inputLines.push(["Text", String(inp.text)]);
    if (inp.value) inputLines.push(["Value", String(inp.value)]);
    if (inp.key) inputLines.push(["Key", String(inp.key)]);
    if (inp.direction) inputLines.push(["Direction", String(inp.direction)]);
    if (inp.url_pattern)
      inputLines.push(["URL Pattern", String(inp.url_pattern)]);
  }
  if (tool.name === "browser_snapshot") {
    if (inp.selector) inputLines.push(["Scope", String(inp.selector)]);
    if (inp.depth) inputLines.push(["Depth", String(inp.depth)]);
  }
  if (tool.name === "browser_execute" && inp.code) {
    inputLines.push(["Code", truncate(String(inp.code), 200)]);
  }

  const isScreenshot =
    tool.name === "browser_snapshot" && actionStr === "screenshot";
  const screenshotPath =
    !isRunning && isScreenshot ? resultContent.trim() : null;
  const isSnapshot =
    tool.name === "browser_snapshot" && actionStr === "snapshot";

  return (
    <div className="flex flex-col gap-1 pl-1">
      {inputLines.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
          {inputLines.map(([label, value]) => (
            <span key={label}>
              <span className="text-muted-foreground">{label}: </span>
              <span className="text-secondary-foreground">{value}</span>
            </span>
          ))}
        </div>
      )}
      {isRunning && (
        <div className="text-muted-foreground text-xs italic">Running…</div>
      )}
      {!isRunning && screenshotPath && screenshotPath.length > 0 && (
        <div className="text-secondary-foreground text-xs">
          Screenshot saved:{" "}
          <span className="text-muted-foreground">{screenshotPath}</span>
        </div>
      )}
      {!isRunning && isSnapshot && resultContent.length > 0 && (
        <div className="mt-0.5 max-h-50 overflow-y-auto">
          <pre className="text-secondary-foreground bg-muted rounded-md px-2 py-1.5 font-mono text-[0.625rem] whitespace-pre-wrap">
            {resultContent.length > 3000
              ? resultContent.slice(0, 3000) + "\n…"
              : resultContent}
          </pre>
        </div>
      )}
      {!isRunning &&
        !isScreenshot &&
        !isSnapshot &&
        resultContent.length > 0 &&
        (tool.name === "browser_execute" ? (
          <div className="mt-0.5 max-h-50 overflow-y-auto">
            <CodeView
              code={
                resultContent.length > 2000
                  ? resultContent.slice(0, 2000) + "\n…"
                  : resultContent
              }
              language="javascript"
            />
          </div>
        ) : (
          <div className="text-secondary-foreground mt-0.5 text-xs">
            {resultContent.length > 200
              ? resultContent.slice(0, 200) + "…"
              : resultContent}
          </div>
        ))}
    </div>
  );
};

// ─── Expand panel dispatcher ──────────────────────────────────────────────────

const ExpandPanel = ({ tool }: { tool: ToolRenderItem }): JSX.Element => {
  switch (tool.name) {
    case "todo_write":
      return (
        <div className="mt-1 mb-0.5 pl-1">
          <TodoList input={tool.input} />
        </div>
      );
    case "bash":
    case "bash_output":
      return (
        <div className="mt-1 mb-0.5">
          <BashOutput tool={tool} />
        </div>
      );
    case "task":
    case "subagent":
      return (
        <div className="mt-1 mb-0.5">
          <TaskSubagentExpand tool={tool} />
        </div>
      );
    case "ask_user_question":
      return (
        <div className="mt-1 mb-0.5 pl-1">
          <AskUserQuestionExpand tool={tool} />
        </div>
      );
    case "read":
      return (
        <div className="mt-1 mb-0.5">
          <ReadFileExpand tool={tool} />
        </div>
      );
    case "write":
    case "edit":
    case "batch_edit":
    case "notebook_edit":
      return (
        <div className="mt-1 mb-0.5">
          <WriteEditExpand tool={tool} />
        </div>
      );
    case "browser_navigate":
    case "browser_snapshot":
    case "browser_interact":
    case "browser_execute":
      return (
        <div className="mt-1 mb-0.5">
          <BrowserToolExpand tool={tool} />
        </div>
      );
    default:
      return <GenericExpand tool={tool} />;
  }
};

// ─── Tool row ─────────────────────────────────────────────────────────────────

// Whether a tool's expand panel would render real content; mirrors each
// ExpandPanel branch's emptiness check so empty rows get a plain header.
function hasExpandableBody(tool: ToolRenderItem): boolean {
  const resultContent = (tool.result?.content ?? "").trim();
  // The deliverables render as the turn's files card; a generic expand would
  // only restate the same arguments as JSON.
  if (componentToolBase(tool.name) === "present_deliverable") return false;
  switch (tool.name) {
    case "read": {
      const raw = tool.result?.content ?? "";
      if (parseImageReadResult(raw) != null) return true;
      return stripLineNumberPrefixes(raw).trim().length > 0;
    }
    case "write":
    case "edit":
    case "batch_edit":
    case "notebook_edit": {
      const c =
        tool.displayData?.finalContent ??
        tool.displayData?.newContent ??
        (typeof tool.input.content === "string"
          ? tool.input.content
          : undefined) ??
        (typeof tool.input.newString === "string"
          ? tool.input.newString
          : undefined) ??
        "";
      return String(c).trim().length > 0;
    }
    case "bash":
    case "bash_output":
      return (
        resultContent.length > 0 ||
        (tool.liveOutput ?? "").trim().length > 0 ||
        (tool.displayData?.streamingOutput ?? "").trim().length > 0
      );
    case "task":
    case "subagent":
      return (tool.displayData?.nestedToolCalls?.length ?? 0) > 0;
    case "todo_write":
      return (
        Array.isArray(tool.input.todos) &&
        (tool.input.todos as unknown[]).length > 0
      );
    case "ask_user_question":
    case "browser_navigate":
    case "browser_snapshot":
    case "browser_interact":
    case "browser_execute":
      return true;
    default: {
      const hasInput =
        Object.keys(tool.input ?? {}).filter((k) => !k.startsWith("_")).length >
        0;
      return hasInput || resultContent.length > 0;
    }
  }
}

const ToolRow = ({
  tool,
  nested = false,
}: {
  tool: ToolRenderItem;
  isFirst?: boolean;
  isLast?: boolean;
  /** Nested rows inside a Task expansion; the CLI ships no result for them. */
  nested?: boolean;
}): JSX.Element => {
  const [expanded, setExpanded] = useState(false);
  const state = tool.state;
  const isRunning = state === "running";
  // Nested rows expand only when the CLI shipped a result.
  const nestedHasBody =
    (tool.result?.content ?? "").trim().length > 0 ||
    (tool.liveOutput?.length ?? 0) > 0 ||
    (tool.displayData?.streamingOutput?.length ?? 0) > 0 ||
    (tool.displayData?.nestedToolCalls?.length ?? 0) > 0;
  // Expand affordance only when the panel would have content.
  const hasExpandableContent = nested ? nestedHasBody : hasExpandableBody(tool);

  // During arg streaming: show icon + shimmer tool name only
  if (tool.streamingArgs) {
    return (
      <div className="flex min-h-6 items-center gap-1.5 rounded-md px-0.5 py-0.5 text-xs/relaxed">
        <span className="text-muted-foreground flex size-6 shrink-0 items-center justify-center [&_svg]:size-4 [&_svg]:stroke-[1.8]">
          <ToolGroupIcon tools={[tool]} />
        </span>
        <ShimmerText className="text-muted-foreground">{tool.name}</ShimmerText>
      </div>
    );
  }

  const { action, chip, isFile, lineInfo, targetPath, isDirectory } =
    getToolLabel(tool);

  return (
    <div className="hover:bg-accent/20 rounded-md transition-colors">
      {/* Row body. Rows sit inside the group card, which supplies the framing —
          so the row itself is a plain icon + label line with no connector art. */}
      <div className="flex min-h-6 min-w-0 items-start gap-1.5 px-0.5 py-0.5 text-xs/relaxed">
        <span
          className={`text-muted-foreground flex size-6 shrink-0 items-center justify-center [&_svg]:size-4 [&_svg]:stroke-[1.8]`}
        >
          <ToolGroupIcon tools={[tool]} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <span
              className={`text-muted-foreground flex min-w-0 flex-1 flex-wrap items-center gap-1 leading-5`}
            >
              {/* Action text shimmers while running. Chip + lineInfo sit OUTSIDE
                the ShimmerText so their content stays visible — the shimmer
                effect uses background-clip:text + transparent fill, which would
                otherwise blank out any nested <code>/ToolChip text. */}
              {isRunning ? (
                <ShimmerText>{action}</ShimmerText>
              ) : (
                <span>{action}</span>
              )}
              {chip != null &&
                chip.length > 0 &&
                (isFile ? (
                  <ToolChip
                    text={chip}
                    isFile
                    additions={tool.displayData?.additions}
                    deletions={tool.displayData?.deletions}
                    targetPath={targetPath}
                    isDirectory={isDirectory}
                  />
                ) : (
                  <code
                    className={`bg-muted border-border rounded border px-1 font-mono text-[0.625rem] ${isRunning ? "" : "text-secondary-foreground"}`}
                  >
                    {chip}
                  </code>
                ))}
              {lineInfo != null && (
                <span
                  className={`text-xs ${isRunning ? "ml-1 opacity-70" : "opacity-60"}`}
                >
                  ({lineInfo})
                </span>
              )}
            </span>
            {hasExpandableContent && !tool.result?.rejected && (
              <Button
                onClick={() => setExpanded((v) => !v)}
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground ms-auto"
                aria-expanded={expanded}
              >
                <ChevronDown
                  className={`transition-transform ${expanded ? "rotate-180" : ""}`}
                />
              </Button>
            )}
          </div>
          {/* Live output preview while running (bash) */}
          {isRunning &&
            tool.liveOutput != null &&
            tool.liveOutput.length > 0 && (
              <div className="bg-bg-terminal border-border mt-0.5 max-h-15 overflow-y-auto rounded border p-1.5 font-mono text-xs break-all whitespace-pre-wrap text-green-200/70">
                {tool.liveOutput}
              </div>
            )}
          {expanded && <ExpandPanel tool={tool} />}
        </div>
      </div>
    </div>
  );
};

// ─── Tool group (collapsible, collapsed by default) ───────────────────────────

function ToolGroupIcon({
  tools,
}: {
  tools: readonly ToolRenderItem[];
}): JSX.Element {
  // A failed call wears the same icon as a successful one: the failure is the
  // agent's to route around, and a red row per empty `which` reads as the chat
  // going wrong.

  switch (toolGroupSummaryKind(tools)) {
    case "read":
      return <Eye />;
    case "edit":
      return <SquarePen />;
    case "command":
      return <Terminal />;
    case "search":
      return <Globe />;
    case "code-search":
      return <Search />;
    case "other":
      return <Wrench />;
    case "mixed":
      return <Hammer />;
  }
}

export const ToolGroupBlock = ({
  id,
  tools,
  summary,
  state,
  expanded: controlledExpanded,
  onExpandedChange,
}: {
  id: string;
  tools: ToolRenderItem[];
  summary: string;
  state: ToolRenderState;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}): JSX.Element => {
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const setExpanded = (next: boolean): void => {
    if (onExpandedChange) onExpandedChange(next);
    else setLocalExpanded(next);
  };
  const resolvedSummary = summary || summarizeToolGroup(tools);

  return (
    <section className="my-0.5" data-tool-group={id}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(!expanded)}
        className="group/tool-group hover:bg-accent/20 focus-visible:ring-ring/70 flex min-h-6 w-full items-center gap-1.5 rounded-md px-0.5 py-0.5 text-start text-xs/relaxed transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset"
        aria-expanded={expanded}
      >
        <span
          className={`text-muted-foreground flex size-6 shrink-0 items-center justify-center [&_svg]:size-4 [&_svg]:stroke-[1.8]`}
        >
          <ToolGroupIcon tools={tools} />
        </span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate">
          {state === "running" ? (
            <ShimmerText>{resolvedSummary}</ShimmerText>
          ) : (
            resolvedSummary
          )}
        </span>
        <ChevronDown
          className={`text-muted-foreground size-3.5 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </Button>
      {expanded && (
        <div className="border-border ms-3.5 border-s py-0.5 ps-2.5">
          {tools.map((tool, index) => (
            <ToolRow key={`${tool.id}-${index}`} tool={tool} />
          ))}
        </div>
      )}
    </section>
  );
};
