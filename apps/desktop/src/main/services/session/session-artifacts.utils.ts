/**
 * Pure extraction rules behind the Artifacts view: given one agent NDJSON
 * message, decide whether it produced an artifact and what to call it. Free
 * of electron and storage so the rules can be exercised without a process.
 */
import path from "path";

import type { SessionArtifactKind } from "#shared/contracts";
import {
  declaredArtifactTargets,
  presentedDeliverables,
} from "#shared/deliverables";

const IMAGE_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);

/**
 * Tools that create or modify a file. Reads are excluded: forty opened files
 * would bury the three actually written. Other agents' aliases are listed
 * too, since the wire contract fixes the envelope, not the tool vocabulary.
 */
const FILE_MUTATION_TOOLS = new Set([
  "write",
  "edit",
  "write_file",
  "patch",
  "notebook_edit",
  "multi_edit",
]);

/** Tools that reach a URL. */
const LINK_TOOLS = new Set([
  "browser_navigate",
  "web_fetch",
  "scrape_url_content",
  "fetch",
  "read_preview",
]);

/**
 * The desktop's component tools, which build a deliverable at a caller-named
 * output path. They arrive as `agent-tools_pdf`; matching is on that exact
 * prefix so a third-party `acme_pdf` is not mined for an `output_path`.
 */
const COMPONENT_TOOL_BASES = [
  "deck_export_pdf",
  "document",
  "pdf",
  "ppt",
  "design",
] as const;
type ComponentToolBase = (typeof COMPONENT_TOOL_BASES)[number];

/** The MCP server name the builtin tools are advertised under. */
const BUILTIN_TOOL_PREFIX = "agent-tools_";

/**
 * Builtin tools whose deliverable exists only in the result text: nothing in
 * the arguments names the file, so their handlers emit an `[artifact]` line.
 */
const MEDIA_TOOLS = new Set([
  "image_generate",
  "text_to_speech",
  "bfl_flux3_get_result",
]);

/** First defined string among the arg aliases a file tool might have used. */
const PATH_ARG_KEYS = [
  "file_path",
  "filePath",
  "filepath",
  "path",
  "target_file",
  "targetFile",
  "notebook_path",
];
const URL_ARG_KEYS = ["url", "uri", "href"];

export interface ArtifactDraft {
  kind: SessionArtifactKind;
  title: string;
  location: string;
  toolName: string;
}

interface ToolCallLike {
  name?: unknown;
  args?: unknown;
  input?: unknown;
}

function firstString(
  record: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0)
      return value.trim();
  }
  return null;
}

/**
 * `(name, args)` of a settled, successful tool call, or null: a failed tool
 * made nothing. Both the canonical `tool_result` envelope and the bundled
 * agent's `tool_execution_complete` shape are accepted.
 */
function settledToolCall(
  event: Record<string, unknown>
): { name: string; args: Record<string, unknown>; output: string } | null {
  const type = event.type;
  let call: ToolCallLike | null = null;
  let failed = false;
  let output: unknown = null;

  if (type === "tool_result") {
    call = (event.toolCall ?? null) as ToolCallLike | null;
    const result = event.result as
      | { error?: unknown; rejection?: unknown; output?: unknown }
      | undefined;
    failed = result?.error != null || result?.rejection != null;
    output = result?.output;
  } else if (type === "tool_execution_complete") {
    call = (event.tool ?? null) as ToolCallLike | null;
    const result = event.result as
      | { rejected?: unknown; content?: unknown }
      | undefined;
    failed = result?.rejected === true;
    output = result?.content;
  }

  if (failed || call == null || typeof call.name !== "string") return null;

  const rawArgs = call.args ?? call.input;
  const args =
    typeof rawArgs === "object" && rawArgs != null
      ? (rawArgs as Record<string, unknown>)
      : {};
  return {
    name: call.name,
    args,
    output: typeof output === "string" ? output : "",
  };
}

/** `example.com/docs/page` — the host plus enough path to tell two links apart. */
function linkTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const trimmedPath =
      parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.host}${trimmedPath}`;
  } catch {
    return url;
  }
}

function fileKind(filePath: string): SessionArtifactKind {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
    ? "image"
    : "file";
}

/** The bare name of a builtin agent-tools tool, prefixed or not. */
function builtinToolName(name: string): string {
  return name.startsWith(BUILTIN_TOOL_PREFIX)
    ? name.slice(BUILTIN_TOOL_PREFIX.length)
    : name;
}

/** The component base a (possibly server-prefixed) tool name resolves to. */
function componentToolBase(name: string): ComponentToolBase | null {
  const bare = builtinToolName(name);
  return (COMPONENT_TOOL_BASES as readonly string[]).includes(bare)
    ? (bare as ComponentToolBase)
    : null;
}

// The pdf and ppt components normalize the output path to `.pdf` before
// writing (createPdf / createDeck); the raw argument may name a file that
// was never written.
function ensurePdfSuffix(rawPath: string): string {
  return rawPath.toLowerCase().endsWith(".pdf")
    ? rawPath
    : `${rawPath.replace(/\.[^./\\]+$/, "")}.pdf`;
}

/**
 * Where an untargeted `reprint` lands. Mirrors `printedTo` in pdf-agent:
 * `<name>-source/document.html` prints to `<name>.pdf`, other HTML beside it.
 */
function reprintTarget(htmlPath: string): string {
  const sourceDir = path.dirname(htmlPath);
  const name = path.basename(sourceDir);
  const suffix = "-source";

  return name.endsWith(suffix)
    ? path.join(path.dirname(sourceDir), `${name.slice(0, -suffix.length)}.pdf`)
    : htmlPath;
}

/**
 * The deliverables a component tool call produced, from its arguments. Each
 * branch resolves to the path the component actually writes, which is not
 * always the argument verbatim.
 */
function componentArtifacts(
  base: ComponentToolBase,
  name: string,
  args: Record<string, unknown>,
  resolve: (raw: string) => string | null
): ArtifactDraft[] {
  const action = typeof args.action === "string" ? args.action : null;

  const dirArtifact = (raw: string | null): ArtifactDraft[] => {
    if (raw == null) return [];
    const absolute = resolve(raw);
    if (absolute == null) return [];
    return [
      {
        kind: "file",
        title: path.basename(absolute),
        location: absolute,
        toolName: name,
      },
    ];
  };

  // `document` has no actions: one file at `output_path`, normalized to `.pdf`.
  if (base === "document") {
    const raw = firstString(args, ["output_path"]);
    if (raw == null) return [];
    const absolute = resolve(ensurePdfSuffix(raw));
    if (absolute == null) return [];
    return [
      {
        kind: "file",
        title: path.basename(absolute),
        location: absolute,
        toolName: name,
      },
    ];
  }

  if (base === "pdf" || base === "ppt" || base === "deck_export_pdf") {
    // `split` writes its pieces into output_dir and has no output_path.
    if (base === "pdf" && action === "split")
      return dirArtifact(firstString(args, ["output_dir"]));

    // pdf actions without an output_path (read/info/tables/forms) made nothing.
    let raw = firstString(args, ["output_path"]);
    if (raw == null && base === "deck_export_pdf") {
      // The export's documented default: the HTML's own path, as .pdf.
      raw = firstString(args, ["html_path"]);
    }
    if (raw == null && base === "pdf" && action === "reprint") {
      const source = firstString(args, ["html_path", "path"]);
      if (source != null) raw = reprintTarget(source);
    }
    if (raw == null) return [];
    const absolute = resolve(ensurePdfSuffix(raw));
    if (absolute == null) return [];
    return [
      {
        kind: "file",
        title: path.basename(absolute),
        location: absolute,
        toolName: name,
      },
    ];
  }

  if (base === "design") {
    const dir = firstString(args, ["output_dir"]);
    if (dir == null) return [];
    const canvas = resolve(path.join(dir, "canvas.html"));
    if (canvas == null) return [];
    const directory = path.dirname(canvas);
    // The per-screen HTML and PNGs are what gets sent on; record them too.
    return [
      {
        kind: "file",
        title: `${path.basename(directory)}/canvas.html`,
        location: canvas,
        toolName: name,
      },
      {
        kind: "file",
        title: `${path.basename(directory)}/screens`,
        location: path.join(directory, "screens"),
        toolName: name,
      },
    ];
  }

  // app: only "create" builds anything; serve/stop/list operate on what exists.
  if (action !== "create") return [];
  return dirArtifact(firstString(args, ["output_dir"]));
}

/**
 * The deliverables a `present_deliverable` call handed over: the items the
 * tool declared after checking the disk, labelled as the call named them. A
 * path the model invented is turned away by the tool and so never filed.
 */
function presentedArtifacts(
  name: string,
  args: Record<string, unknown>,
  output: string,
  resolve: (raw: string) => string | null
): ArtifactDraft[] {
  const drafts: ArtifactDraft[] = [];

  for (const item of presentedDeliverables(args, output)) {
    if (item.isUrl) {
      drafts.push({
        kind: "link",
        title: item.label ?? linkTitle(item.path),
        location: item.path,
        toolName: name,
      });
      continue;
    }

    const absolute = resolve(item.path);
    if (absolute == null) continue;
    drafts.push({
      kind: fileKind(absolute),
      title: item.label ?? path.basename(absolute),
      location: absolute,
      toolName: name,
    });
  }

  return drafts;
}

/**
 * Absolute paths a builtin tool declared in its result text. Only builtin
 * media tools are mined, so a `bash` call printing the marker cannot file one.
 */
function declaredArtifacts(name: string, output: string): ArtifactDraft[] {
  if (!MEDIA_TOOLS.has(builtinToolName(name))) return [];

  const drafts: ArtifactDraft[] = [];
  for (const location of declaredArtifactTargets(output)) {
    if (!path.isAbsolute(location)) continue;
    drafts.push({
      kind: fileKind(location),
      title: path.basename(location),
      location,
      toolName: name,
    });
  }
  return drafts;
}

/**
 * The artifacts one NDJSON message produced: usually none, sometimes several.
 * `workspacePath` resolves relative tool arguments; a relative path with no
 * workspace is dropped rather than recorded as an unopenable location.
 */
export function extractArtifacts(
  payload: unknown,
  workspacePath: string | null
): ArtifactDraft[] {
  const message = payload as { type?: unknown; event?: unknown } | null;
  if (message == null || message.type !== "event") return [];
  const event = message.event;
  if (typeof event !== "object" || event == null) return [];

  const call = settledToolCall(event as Record<string, unknown>);
  if (call == null) return [];

  // Relative path with no workspace to resolve against → dropped, per above.
  const resolve = (raw: string): string | null =>
    path.isAbsolute(raw)
      ? raw
      : workspacePath != null
        ? path.resolve(workspacePath, raw)
        : null;

  if (FILE_MUTATION_TOOLS.has(call.name)) {
    const rawPath = firstString(call.args, PATH_ARG_KEYS);
    if (rawPath == null) return [];
    const absolute = resolve(rawPath);
    if (absolute == null) return [];
    return [
      {
        kind: fileKind(absolute),
        title: path.basename(absolute),
        location: absolute,
        toolName: call.name,
      },
    ];
  }

  if (LINK_TOOLS.has(call.name)) {
    const url = firstString(call.args, URL_ARG_KEYS);
    if (url == null || !/^https?:\/\//i.test(url)) return [];
    return [
      {
        kind: "link",
        title: linkTitle(url),
        location: url,
        toolName: call.name,
      },
    ];
  }

  // Component tools (pdf/ppt/app/design) name their output path in arguments.
  const componentBase = componentToolBase(call.name);
  if (componentBase != null) {
    return componentArtifacts(componentBase, call.name, call.args, resolve);
  }

  // Generated media is named by the handler, so the path is in the result text.
  const declared = declaredArtifacts(call.name, call.output);
  if (declared.length > 0) return declared;

  // `present_deliverable` states outright what the turn produced; it is the
  // only source for a file written by `bash`.
  if (builtinToolName(call.name) === "present_deliverable") {
    return presentedArtifacts(call.name, call.args, call.output, resolve);
  }

  return [];
}
