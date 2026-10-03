/**
 * What the builtin component tools produce, read from their arguments. A
 * port of the old renderer's `components/chat/component-tools.ts` (spec 03
 * §11.3a), so the deliverables card agrees with it.
 */

/** A file path from tool input; tools use camelCase, both are accepted. */
export function getFilePath(input: Record<string, unknown>): string | null {
  for (const k of [
    "filePath",
    "file_path",
    "notebookPath",
    "notebook_path",
    "path",
  ]) {
    const v = input[k];
    if (v != null && String(v).trim().length > 0) return String(v);
  }
  return null;
}

export function basename(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

// Prefixed with their MCP server's name (`agent-tools_ppt`): matched by suffix.
const COMPONENT_TOOL_BASES = [
  "deck_export_pdf",
  "document",
  "present_deliverable",
  "pdf",
  "ppt",
  "design",
] as const;
export type ComponentToolBase = (typeof COMPONENT_TOOL_BASES)[number];

export function componentToolBase(name: string): ComponentToolBase | null {
  for (const base of COMPONENT_TOOL_BASES) {
    if (name === base || name.endsWith(`_${base}`)) return base;
  }
  return null;
}

// pdf and ppt normalise their output path to `.pdf` before writing.
function ensurePdfSuffix(rawPath: string): string {
  return rawPath.toLowerCase().endsWith(".pdf")
    ? rawPath
    : `${rawPath.replace(/\.[^./\\]+$/, "")}.pdf`;
}

// Where a pdf `reprint` writes when it is not told (pdf-agent's `printedTo`).
function reprintTarget(htmlPath: string): string {
  const parts = htmlPath.split(/[/\\]/);
  const sourceDir = parts[parts.length - 2] ?? "";
  const suffix = "-source";
  if (!sourceDir.endsWith(suffix)) return htmlPath;
  return [
    ...parts.slice(0, -2),
    `${sourceDir.slice(0, -suffix.length)}.pdf`,
  ].join("/");
}

/** The file a component call built, or null when it built nothing. */
export function componentOutputPath(
  base: ComponentToolBase,
  input: Record<string, unknown>
): string | null {
  const str = (k: string): string => String(input[k] ?? "").trim();
  const action = str("action");

  if (base === "document") {
    const raw = str("output_path");
    return raw.length === 0 ? null : ensurePdfSuffix(raw);
  }
  if (base === "pdf" || base === "ppt" || base === "deck_export_pdf") {
    const source = str("html_path") || str("path");
    const raw =
      str("output_path") ||
      (base === "deck_export_pdf"
        ? str("html_path")
        : base === "pdf" && action === "reprint" && source.length > 0
          ? reprintTarget(source)
          : "");
    return raw.length === 0 ? null : ensurePdfSuffix(raw);
  }
  if (base === "design") {
    const dir = str("output_dir");
    return dir.length === 0 ? null : `${dir.replace(/[/\\]$/, "")}/canvas.html`;
  }
  return null;
}
