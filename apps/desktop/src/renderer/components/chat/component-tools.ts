/**
 * What the builtin component tools produce, read from their arguments. Shared
 * by the tool row's chip and the deliverables card so they never disagree.
 */

// ─── Paths ────────────────────────────────────────────────────────────────────

// Resolve a file path from tool input — tools use camelCase but we accept both
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

// ─── Component tools (pdf / ppt / design / app / present_deliverable) ─────────

// These arrive prefixed with their MCP server's name (`agent-tools_ppt`), so
// they are matched by suffix: the prefix is the server's, not the tool's.
export const COMPONENT_TOOL_BASES = [
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

// pdf and ppt normalize their output path to `.pdf` before writing, so the raw
// argument names a file that was never written.

export function ensurePdfSuffix(rawPath: string): string {
  return rawPath.toLowerCase().endsWith(".pdf")
    ? rawPath
    : `${rawPath.replace(/\.[^./\\]+$/, "")}.pdf`;
}

// Where a pdf `reprint` writes when it is not told. Mirrors `printedTo` in
// pdf-agent: `<name>-source/document.html` sits beside `<name>.pdf`.
export function reprintTarget(htmlPath: string): string {
  const parts = htmlPath.split(/[/\\]/);
  const sourceDir = parts[parts.length - 2] ?? "";
  const suffix = "-source";
  if (!sourceDir.endsWith(suffix)) return htmlPath;
  return [
    ...parts.slice(0, -2),
    `${sourceDir.slice(0, -suffix.length)}.pdf`,
  ].join("/");
}

/**
 * The file a component call built, or null when it built nothing (a pdf
 * `read`, an `app` list). Mirrors session-artifacts.utils.ts.
 */
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
    // The design component always writes `canvas.html` inside its output dir.
    return dir.length === 0 ? null : `${dir.replace(/[/\\]$/, "")}/canvas.html`;
  }
  return null;
}

// ─── present_deliverable ─────────────────────────────────────────────────────

export {
  isDeliverableUrl,
  requestedDeliverables as deliverableItems,
  type DeliverableItem,
} from "#shared/deliverables";
