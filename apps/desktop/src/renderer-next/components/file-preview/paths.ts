/**
 * Path rules for opening a file a bot mentioned or made (spec 03 §11.3a),
 * ported from the old `utils/preview-utils.ts`, `utils/file-type-utils.ts`
 * and `hooks/use-workspace-root.ts`. Pure.
 */

/** Guest-side workspace mount; main maps it onto the host root. */
const GUEST_WORKSPACE_PREFIX = "/workspace";

/** Absolute on POSIX (`/x`) or Windows (`C:\x`, `\\server\x`). */
export const isAbsoluteFilePath = (value: string): boolean =>
  value.startsWith("/") ||
  /^[a-zA-Z]:[\\/]/.test(value) ||
  value.startsWith("\\\\");

/** Directory holding `filePath`, for both separator conventions. */
export const parentDirectory = (filePath: string): string => {
  const lastSlash = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\")
  );
  return lastSlash > 0 ? filePath.slice(0, lastSlash) : "";
};

/**
 * A tool-reported path anchored to the workspace: absolute paths are kept,
 * relative ones joined to the root (a relative read fails otherwise).
 */
export const resolveWorkspacePath = (
  path: string,
  workspaceRoot: string | null
): string => {
  if (path.length === 0) return path;
  if (isAbsoluteFilePath(path) || workspaceRoot == null) return path;
  return `${workspaceRoot.replace(/[\\/]+$/, "")}/${path.replace(/^\.\//, "")}`;
};

/**
 * The containment root a read needs: guest `/workspace/...` paths use the
 * real workspace root (main rewrites them against it); other absolute paths
 * their own directory.
 */
export const containmentRootFor = (
  filePath: string,
  workspaceRoot: string | null
): string => {
  if (
    filePath === GUEST_WORKSPACE_PREFIX ||
    filePath.startsWith(`${GUEST_WORKSPACE_PREFIX}/`)
  )
    return workspaceRoot ?? "";
  if (isAbsoluteFilePath(filePath)) return parentDirectory(filePath);
  return workspaceRoot ?? parentDirectory(filePath);
};

export type FileCategory =
  | "image"
  | "code"
  | "text"
  | "markdown"
  | "html"
  | "document"
  | "presentation"
  | "binary"
  | "unknown";

const IMAGE_EXTS = new Set(
  "png jpg jpeg gif webp bmp ico tif tiff svg".split(" ")
);
const CODE_EXTS = new Set(
  (
    "ts tsx js jsx mjs cjs py rs go java c cpp h hpp css scss less sh bash zsh " +
    "sql vue svelte rb php swift kt kts scala lua r pl pm ex exs erl hs clj " +
    "cljs dart groovy ps1 bat cmd fish makefile cmake dockerfile"
  ).split(" ")
);
const MARKDOWN_EXTS = new Set(["md", "mdx"]);
const HTML_EXTS = new Set(["html", "htm"]);
const TEXT_EXTS = new Set(
  (
    "txt log csv tsv cfg ini conf env properties xml json jsonc yaml yml toml " +
    "lock gitignore editorconfig"
  ).split(" ")
);
const DOCUMENT_EXTS = new Set(["pdf", "docx", "xlsx", "xls"]);
const PRESENTATION_EXTS = new Set(["pptx", "potx", "ppsx"]);
const BINARY_EXTS = new Set(
  (
    "zip tar gz 7z rar bz2 xz exe dll so dylib bin dat msi app dmg doc ppt odt " +
    "ods odp sqlite db wasm class jar pyc pyo o a obj lib mp3 mp4 avi mov wav " +
    "flac ogg webm mkv aac wma ttf otf woff woff2 eot"
  ).split(" ")
);

export const fileExtension = (filePath: string): string => {
  const name = filePath.split(/[/\\]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
};

export const categorizeFile = (filePath: string): FileCategory => {
  const ext = fileExtension(filePath);
  if (!ext) return "unknown";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (PRESENTATION_EXTS.has(ext)) return "presentation";
  if (DOCUMENT_EXTS.has(ext)) return "document";
  if (BINARY_EXTS.has(ext)) return "binary";
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (HTML_EXTS.has(ext)) return "html";
  if (CODE_EXTS.has(ext)) return "code";
  if (TEXT_EXTS.has(ext)) return "text";
  return "unknown";
};

/**
 * How the read-only preview shows a file: rendered in the app, or handed to
 * the OS (`external`: office documents, binaries). pdf and html open
 * externally until the in-app renderers are ported.
 */
export type PreviewKind =
  | "image"
  | "markdown"
  | "code"
  | "text"
  | "pptx"
  | "pdf"
  | "html"
  | "external";

export const previewKind = (filePath: string): PreviewKind => {
  if (fileExtension(filePath) === "pdf") return "pdf";
  switch (categorizeFile(filePath)) {
    case "image":
      return "image";
    case "markdown":
      return "markdown";
    case "code":
      return "code";
    case "text":
    case "unknown":
      return "text";
    case "presentation":
      return "pptx";
    case "html":
      return "html";
    default:
      return "external";
  }
};

/**
 * Whether the old preview pane rendered it in the app (the rule for opening
 * it unasked on `preview-open`): pptx, pdf, html, image, markdown, code, text.
 */
export const hasInAppViewer = (filePath: string): boolean => {
  const category = categorizeFile(filePath);
  if (category === "presentation" || category === "html") return true;
  if (filePath.toLowerCase().endsWith(".pdf")) return true;
  return (
    category === "image" ||
    category === "markdown" ||
    category === "code" ||
    category === "text"
  );
};

export const isUrl = (value: string): boolean => /^https?:\/\//i.test(value);
