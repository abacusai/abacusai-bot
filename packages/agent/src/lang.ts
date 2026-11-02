/**
 * Thin wrapper over ast-grep's tree-sitter parsers for the syntax checks.
 * ast-grep is a native module whose ABI must match the running Node, which
 * the desktop app cannot guarantee, so it is optional: loaded via a guarded
 * require, and when missing `langForFile` reports "unknown" and the check
 * does nothing. Adapted from codingagent-lite (abacusai/codingagent-lite), MIT.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import { writeFileAtomicSync } from "./atomic-file.js";
import { childProcessEnv } from "./child-env.js";
import { agentDir } from "./config.js";

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
      ".html": Lang.Html!,
      ".css": Lang.Css!,
    };

    astGrep = module;
  } catch {
    astGrep = null;
  }

  if (astGrep != null) {
    void probeGrammars();
    registerPython();
  }

  return astGrep;
}

/**
 * Python isn't built in: its grammar is a separate native library. One the OS
 * refuses to load (Windows application control, a damaged file) makes ast-grep
 * panic, which aborts the process past any try/catch. So a child process loads
 * and parses with it first, and Python is registered only if the child lived.
 * Until then `.py` has no grammar and its checks are skipped, as for any file.
 */
let pythonGrammar: unknown;
let pythonRegistered = false;
let grammarProbe: Promise<void> | undefined;

/** Starts the probe once per process; the agent calls it at startup so it is settled before the first write. */
export function probeGrammars(): Promise<void> {
  grammarProbe ??= (async () => {
    const grammar = require.resolve("@ast-grep/lang-python");

    if (await probeGrammar(grammar)) {
      pythonGrammar = require(grammar);
      registerPython();
    }
  })().catch(() => {
    /* No Python grammar here; other languages still work. */
  });

  return grammarProbe;
}

function registerPython(): void {
  if (astGrep == null || pythonGrammar === undefined || pythonRegistered) {
    return;
  }
  pythonRegistered = true;
  try {
    astGrep.registerDynamicLanguage({ python: pythonGrammar });
    extensionMap[".py"] = "python";
  } catch {
    /* Python support unavailable; other languages still work. */
  }
}

/** Generous: the first load of a native library can wait on the virus scanner. */
const GRAMMAR_PROBE_TIMEOUT_MS = 20_000;
/** A refused grammar is asked again after a day, so an allowlist change needs no app update. */
const GRAMMAR_RETRY_MS = 24 * 60 * 60 * 1000;

/** What a child concluded: true or false, or undefined when it never answered (timeout, no spawn). */
export type GrammarProbeRun = (
  napi: string,
  grammar: string
) => Promise<boolean | undefined>;

interface GrammarVerdict {
  mtimeMs: number;
  size: number;
  ok: boolean;
  at: number;
}

/**
 * Whether the grammar module at `grammar` loads and parses in a child. The
 * answer is kept in the agent dir, keyed by the library file, so a process
 * spawns the child only when that file is new or changed (or a refusal is a
 * day old). No answer is not kept: the grammar is skipped for this process.
 */
export async function probeGrammar(
  grammar: string,
  run: GrammarProbeRun = runGrammarProbe,
  cacheFile = path.join(agentDir(), "grammar-probes.json"),
  now = Date.now()
): Promise<boolean> {
  const library = (require(grammar) as { libraryPath: string }).libraryPath;
  const { mtimeMs, size } = fs.statSync(library);
  let cache: Record<string, GrammarVerdict> = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as typeof cache;
  } catch {
    /* No cache yet, or an unreadable one: probe. */
  }

  const known = cache[library];
  if (
    known?.mtimeMs === mtimeMs &&
    known.size === size &&
    (known.ok || now - known.at < GRAMMAR_RETRY_MS)
  ) {
    return known.ok;
  }

  const ok = await run(require.resolve("@ast-grep/napi"), grammar);
  if (ok === undefined) {
    return false;
  }
  try {
    cache[library] = { mtimeMs, size, ok, at: now };
    writeFileAtomicSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    /* Unwritable agent dir: the next process probes again. */
  }

  return ok;
}

const GRAMMAR_PROBE_SCRIPT = `
const [napi, grammar] = process.argv.slice(1);
const astGrep = require(napi);
astGrep.registerDynamicLanguage({ python: require(grammar) });
astGrep.parse("python", "x = 1\\n").root();
process.stdout.write("ok");
`;

/** On the agent's own runtime, as the desktop launches the agent itself. */
const runGrammarProbe: GrammarProbeRun = (napi, grammar) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      ["-e", GRAMMAR_PROBE_SCRIPT, napi, grammar],
      {
        env: childProcessEnv(process.env, { ELECTRON_RUN_AS_NODE: "1" }),
        timeout: GRAMMAR_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        // Killed on timeout, or never started (spawn errors have a string code).
        if (error?.killed === true || typeof error?.code === "string") {
          resolve(undefined);
          return;
        }
        resolve(error == null && stdout === "ok");
      }
    );
  });

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
