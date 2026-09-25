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

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "tif",
  "tiff",
  "svg",
]);

const CODE_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "css",
  "scss",
  "less",
  "sh",
  "bash",
  "zsh",
  "sql",
  "vue",
  "svelte",
  "rb",
  "php",
  "swift",
  "kt",
  "kts",
  "scala",
  "lua",
  "r",
  "pl",
  "pm",
  "ex",
  "exs",
  "erl",
  "hs",
  "clj",
  "cljs",
  "dart",
  "groovy",
  "ps1",
  "bat",
  "cmd",
  "fish",
  "makefile",
  "cmake",
  "dockerfile",
]);

const MARKDOWN_EXTS = new Set(["md", "mdx"]);

const HTML_EXTS = new Set(["html", "htm"]);

const TEXT_EXTS = new Set([
  "txt",
  "log",
  "csv",
  "tsv",
  "cfg",
  "ini",
  "conf",
  "env",
  "properties",
  "xml",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "lock",
  "gitignore",
  "editorconfig",
]);

const DOCUMENT_EXTS = new Set(["pdf", "docx", "xlsx", "xls"]);

// OOXML only: legacy binary .ppt is a different format and stays binary.
const PRESENTATION_EXTS = new Set(["pptx", "potx", "ppsx"]);

const BINARY_EXTS = new Set([
  "zip",
  "tar",
  "gz",
  "7z",
  "rar",
  "bz2",
  "xz",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "dat",
  "msi",
  "app",
  "dmg",
  "doc",
  "ppt",
  "odt",
  "ods",
  "odp",
  "sqlite",
  "db",
  "wasm",
  "class",
  "jar",
  "pyc",
  "pyo",
  "o",
  "a",
  "obj",
  "lib",
  "mp3",
  "mp4",
  "avi",
  "mov",
  "wav",
  "flac",
  "ogg",
  "webm",
  "mkv",
  "aac",
  "wma",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
]);

export const getFileExtension = (filePath: string): string => {
  const name = filePath?.split(/[/\\]/)?.pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
};

export const categorizeFile = (filePath: string): FileCategory => {
  const ext = getFileExtension(filePath);
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

export const isPreviewable = (filePath: string): boolean => {
  const cat = categorizeFile(filePath);
  return cat !== "binary";
};

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  css: "css",
  scss: "scss",
  less: "less",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  ps1: "powershell",
  bat: "batch",
  cmd: "batch",
  sql: "sql",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  mdx: "markdown",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  lua: "lua",
  r: "r",
  pl: "perl",
  pm: "perl",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  clj: "clojure",
  cljs: "clojure",
  dart: "dart",
  groovy: "groovy",
  vue: "html",
  svelte: "html",
  dockerfile: "docker",
  makefile: "makefile",
  cmake: "cmake",
  csv: "text",
  tsv: "text",
  txt: "text",
  log: "text",
  cfg: "text",
  ini: "ini",
  conf: "text",
  env: "text",
  properties: "properties",
  lock: "text",
  gitignore: "text",
  editorconfig: "text",
};

export const getLanguageForExt = (ext: string): string => {
  return EXT_TO_LANGUAGE[ext?.toLowerCase()] ?? "text";
};

const MIME_TO_IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/tiff": "tiff",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
};

const mimeToImageExt = (mimeType?: string | null): string => {
  const clean = (mimeType ?? "").split(";")[0]?.trim().toLowerCase();
  return MIME_TO_IMAGE_EXT[clean] ?? "png";
};

const MAX_DOWNLOAD_BASENAME = 80;

// No control-char regex literal: oxlint no-control-regex.
const stripControlChars = (s: string): string =>
  Array.from(s)
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c > 31 && c !== 127;
    })
    .join("");

// A safe `<name>.<ext>` download name from the URL's basename (stable, unlike
// a mangled prompt). The MIME type only supplies the extension when the URL
// has none; data:/blob: URLs fall back to `image-<timestamp>`.
export const buildImageDownloadName = (
  url: string | undefined,
  mimeType?: string | null
): string => {
  const mimeExt = mimeToImageExt(mimeType);

  let segment = "";
  const raw = (url ?? "").trim();
  if (raw && !raw.startsWith("data:") && !raw.startsWith("blob:")) {
    const path = raw.split(/[?#]/)[0];
    const lastSlash = path.lastIndexOf("/");
    let last = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
    try {
      last = decodeURIComponent(last);
    } catch {
      /* malformed escape; keep as-is */
    }
    segment = last;
  }

  let base = stripControlChars(segment.normalize("NFKD"))
    .replace(/[/\\?%*:|"<>]/g, "") // chars illegal in filenames
    .trim();

  let urlExt = "";
  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    urlExt = base.slice(dot + 1).toLowerCase();
    base = base.slice(0, dot);
  }

  // The URL's extension only when it is a real image type; else the MIME's.
  const ext = IMAGE_EXTS.has(urlExt)
    ? urlExt === "jpeg"
      ? "jpg"
      : urlExt
    : mimeExt;

  base = base.replace(/\s+/g, "-");
  if (base.length > MAX_DOWNLOAD_BASENAME) {
    base = base.slice(0, MAX_DOWNLOAD_BASENAME).replace(/-+$/, "");
  }
  if (!base) base = `image-${Date.now()}`; // no usable URL name; stay collision-free

  return `${base}.${ext}`;
};
