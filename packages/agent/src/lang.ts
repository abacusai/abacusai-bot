/**
 * Thin wrapper over ast-grep's tree-sitter parsers for the syntax checks.
 * ast-grep is a native module whose ABI must match the running Node, which
 * the desktop app cannot guarantee, so it is optional: loaded via a guarded
 * require, and when missing `langForFile` reports "unknown" and the check
 * does nothing. Adapted from codingagent-lite (abacusai/codingagent-lite), MIT.
 */
import { createRequire } from "node:module";
import * as path from "node:path";

export type SupportedLang = string;

export interface AstGrepNode {
  kind(): string;
  text(): string;
  range(): {
    start: { line: number; index: number };
    end: { line: number; index: number };
  };
  children(): AstGrepNode[];
  /** Structural search. Present only on a real ast-grep build. */
  findAll?: (options: {
    rule: { pattern?: string; kind?: string };
  }) => AstGrepNode[];
  /** Named field of a node, e.g. the `name` of a function declaration. */
  field?: (name: string) => AstGrepNode | null;
  /** Single-node metavariable capture ($NAME). */
  getMatch?: (name: string) => AstGrepNode | null;
  /** Multi-node metavariable capture ($$$NAME). */
  getMultipleMatches?: (name: string) => AstGrepNode[];
  /** Stage a replacement of this node's text. */
  replace?: (text: string) => unknown;
  /** Apply staged replacements, returning the new source. */
  commitEdits?: (edits: unknown[]) => string;
}

interface AstGrepModule {
  Lang: Record<string, string>;
  parse: (lang: SupportedLang, source: string) => { root(): AstGrepNode };
  registerDynamicLanguage: (languages: Record<string, unknown>) => void;
}

/**
 * Whether the native parser is present. The structural tools ask first: an
 * `ast_edit` that silently did nothing would look like a successful edit.
 */
export function astGrepAvailable(): boolean {
  return loadAstGrep() != null;
}

/** File extensions the parser can handle, for tools that must say what they support. */
export function supportedExtensions(): string[] {
  loadAstGrep();

  return Object.keys(extensionMap);
}

/**
 * Parse source into a tree. Throws when the parser is missing: an empty tree
 * would read as "no matches" when the truth is "no parser".
 */
export function parseSource(
  lang: SupportedLang,
  source: string
): { root(): AstGrepNode } {
  const module = loadAstGrep();

  if (!module) {
    throw new Error("ast-grep is not available in this build.");
  }

  return module.parse(lang, source);
}

const require = createRequire(import.meta.url);

let astGrep: AstGrepModule | null | undefined;
let extensionMap: Record<string, SupportedLang> = {};

function loadAstGrep(): AstGrepModule | null {
  if (astGrep !== undefined) {
    return astGrep;
  }

  try {
    const module = require("@ast-grep/napi") as AstGrepModule;

    try {
      // Python isn't built in; registering it is best-effort so a failure here
      // only costs Python coverage, not every other language.
      const python = require("@ast-grep/lang-python") as unknown;

      module.registerDynamicLanguage({ python });
    } catch {
      /* Python support unavailable; other languages still work. */
    }

    const { Lang } = module;

    extensionMap = {
      ".ts": Lang.TypeScript!,
      ".mts": Lang.TypeScript!,
      ".cts": Lang.TypeScript!,
      ".tsx": Lang.Tsx!,
      ".js": Lang.JavaScript!,
      ".mjs": Lang.JavaScript!,
      ".cjs": Lang.JavaScript!,
      ".jsx": Lang.Tsx!,
      ".py": "python",
      ".html": Lang.Html!,
      ".css": Lang.Css!,
    };

    astGrep = module;
  } catch {
    astGrep = null;
  }

  return astGrep;
}

export function langForFile(filePath: string): SupportedLang | undefined {
  if (!loadAstGrep()) {
    return undefined;
  }

  return extensionMap[path.extname(filePath).toLowerCase()];
}

export interface SyntaxError {
  /** 1-based, to match how editors and compilers report positions. */
  line: number;
  snippet: string;
}

/**
 * Collect tree-sitter ERROR nodes; `[]` means the file parses cleanly. ERROR
 * nodes are not descended into: their children would bury the line to fix.
 */
export function findSyntaxErrors(
  lang: SupportedLang,
  source: string,
  maxErrors = 5
): SyntaxError[] {
  const module = loadAstGrep();

  if (!module) {
    return [];
  }

  const errors: SyntaxError[] = [];
  const stack: AstGrepNode[] = [module.parse(lang, source).root()];

  while (stack.length > 0 && errors.length < maxErrors) {
    const node = stack.pop();

    if (!node) {
      break;
    }

    if (node.kind() === "ERROR") {
      errors.push({
        line: node.range().start.line + 1,
        snippet: firstLine(node.text(), 100),
      });

      continue;
    }

    // Pushed in reverse so errors come back out in document order.
    const children = node.children();

    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index];

      if (child) {
        stack.push(child);
      }
    }
  }

  return errors;
}

export function firstLine(text: string, maxChars = 120): string {
  const line = text.split("\n", 1)[0] ?? "";

  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}
