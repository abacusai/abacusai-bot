import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Deterministic AST tools (ast-grep / tree-sitter). ast_edit: structural
 * search-and-replace with metavariables, reverted if it breaks the parse.
 * code_map: symbol index for a file or directory; classification in
 * symbols.ts, the walk in workspace-scan.ts, the limits and their messages
 * here. ast-grep is optional (see lang.ts), so both tools say "no parser"
 * rather than "no matches". Ported from codingagent-lite, MIT.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  astGrepAvailable,
  findSyntaxErrors,
  firstLine,
  langForFile,
  parseSource,
  supportedExtensions,
  type AstGrepNode,
} from "../lang.js";
import {
  familyFor,
  matchesQuery,
  queryTerms,
  renderSymbols,
  symbolsIn,
  type CodeSymbol,
} from "../symbols.js";
import {
  collectFiles,
  isIndexableContent,
  type ScanResult,
} from "../workspace-scan.js";

/**
 * Scan limits: one call over a large repository is a bounded cost, and every
 * limit that bites reports itself.
 */
const MAX_FILES = 2_000;
const MAX_DEPTH = 24;
const SCAN_BUDGET_MS = 10_000;
/**
 * Wall clock for walk and parsing together: a partial map that says it is
 * partial beats a call the watchdog kills, which returns nothing.
 */
const CALL_BUDGET_MS = 20_000;
const MAX_FILE_BYTES = 1_500_000;
const MAX_OUTPUT_CHARS = 20_000;
/**
 * Per-file share of the output for a tree scan, so a few enormous files at the
 * top of the alphabet cannot spend the whole budget. A file asked for by name
 * is exempt.
 */
const MAX_CHARS_PER_FILE = 2_400;

/** What `code_map` can index, as opposed to what the parser can merely read. */
const INDEXED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".py",
  ".css",
];

/** One file's symbols, trimmed to its share of the output in source order. */
function renderCapped(
  symbols: CodeSymbol[],
  limit: boolean
): { text: string; omitted: number } {
  const rendered = renderSymbols(symbols);

  if (!limit || rendered.length <= MAX_CHARS_PER_FILE)
    return { text: rendered, omitted: 0 };

  // Whole symbols, so every printed line is complete; exact bytes matter less.
  let kept = symbols.length;
  while (
    kept > 1 &&
    renderSymbols(symbols.slice(0, kept)).length > MAX_CHARS_PER_FILE
  ) {
    kept = Math.floor(kept * 0.8);
  }

  const omitted = symbols.length - kept;

  return {
    text: `${renderSymbols(symbols.slice(0, kept))}\n       … ${omitted} more in this file`,
    omitted,
  };
}

/** Forward slashes on every platform: the label is quoted back into greps. */
function relativeLabel(cwd: string, file: string): string {
  const relative = path.relative(cwd, file);

  return (relative === "" || relative.startsWith("..") ? file : relative)
    .split(path.sep)
    .join("/");
}

/** Metavariable names a pattern or rewrite mentions, split by arity. */
export function metaVarsIn(template: string): {
  single: Set<string>;
  multi: Set<string>;
} {
  const single = new Set<string>();
  const multi = new Set<string>();

  for (const m of template.matchAll(
    /\$\$\$([A-Z_][A-Z0-9_]*)|\$([A-Z_][A-Z0-9_]*)/g
  )) {
    if (m[1] != null) multi.add(m[1]);
    else if (m[2] != null) single.add(m[2]);
  }

  return { single, multi };
}

/**
 * Metavariables the rewrite uses that the pattern never binds. An unbound
 * `$NAME` is emitted literally and is a legal JS identifier, so the syntax
 * check passes; an unbound `$$$NAME` expands to nothing and silently deletes.
 */
export function unboundMetaVars(pattern: string, rewrite: string): string[] {
  const declared = metaVarsIn(pattern);
  const used = metaVarsIn(rewrite);
  const unbound: string[] = [];

  for (const name of used.single) {
    if (!declared.single.has(name) && !declared.multi.has(name))
      unbound.push(`$${name}`);
  }

  for (const name of used.multi) {
    if (!declared.multi.has(name)) unbound.push(`$$$${name}`);
  }

  return unbound.sort();
}

/** Substitute a match's metavariables into the rewrite template. */
export function substituteMetaVars(
  source: string,
  match: AstGrepNode,
  template: string
): string {
  // One pass: a second scan for $NAME would substitute into matched text.
  return template.replace(
    /\$\$\$([A-Z_][A-Z0-9_]*)|\$([A-Z_][A-Z0-9_]*)/g,
    (whole, multi?: string, single?: string) => {
      if (multi != null) {
        // Slice the source across the nodes so separators survive exactly.
        const nodes = match.getMultipleMatches!(multi);
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (first == null || last == null) return "";
        return source.slice(first.range().start.index, last.range().end.index);
      }
      const node = match.getMatch!(single as string);
      return node ? node.text() : whole;
    }
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ast_edit",
    label: "AST Edit",
    description:
      "Structural search-and-replace using ast-grep patterns (tree-sitter based). " +
      "Matches code by syntax structure, not text: whitespace and formatting differences don't matter. " +
      "Use metavariables: $NAME matches one node (e.g. `console.log($MSG)`), $$$ARGS matches many " +
      "(e.g. `foo($$$ARGS)`). The same metavariables can be used in the rewrite. " +
      "Supported: .ts .tsx .js .jsx .py .html .css. " +
      "Prefer this over edit when renaming calls, changing call signatures, or applying the same " +
      "change to every occurrence in a file. Reverts automatically if the rewrite breaks the syntax.",
    parameters: Type.Object({
      path: Type.String({ description: "File to modify" }),
      pattern: Type.String({
        description: "ast-grep pattern to match, e.g. `oldFn($$$ARGS)`",
      }),
      rewrite: Type.String({
        description:
          "Replacement, may reuse metavariables, e.g. `newFn($$$ARGS)`",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!astGrepAvailable()) {
        return {
          content: [
            {
              type: "text",
              text: "ast_edit is unavailable: this build has no ast-grep parser. Use edit instead.",
            },
          ],
          isError: true,
          details: {},
        };
      }
      const abs = path.resolve(ctx.cwd, params.path);
      const lang = langForFile(abs);
      if (!lang) {
        return {
          content: [
            {
              type: "text",
              text: `ast_edit does not support this file type. Supported: ${supportedExtensions().join(" ")}`,
            },
          ],
          isError: true,
          details: {},
        };
      }
      let source: string;
      try {
        source = fs.readFileSync(abs, "utf8");
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Cannot read ${params.path}: ${(e as Error).message}`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      const errorsBefore = findSyntaxErrors(lang, source).length;
      const root = parseSource(lang, source).root();
      let matches: AstGrepNode[];
      try {
        matches = root.findAll!({ rule: { pattern: params.pattern } });
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Invalid pattern: ${(e as Error).message}` },
          ],
          isError: true,
          details: {},
        };
      }
      if (matches.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `No matches for pattern \`${params.pattern}\` in ${params.path}. ` +
                `Patterns must be valid ${lang} syntax; use $VAR for one node, $$$VAR for a list.`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      const unbound = unboundMetaVars(params.pattern, params.rewrite);
      if (unbound.length > 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `Rewrite uses ${unbound.join(", ")}, which the pattern never binds. ` +
                `File left unchanged. A single-node capture is $NAME and a list is $$$NAME; ` +
                `both have to appear in the pattern before the rewrite can use them.`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      const lines = matches.map((m) => m.range().start.line + 1);
      const edits = matches.map((m) =>
        m.replace!(substituteMetaVars(source, m, params.rewrite))
      );
      const newSource = root.commitEdits!(edits);

      const errorsAfter = findSyntaxErrors(lang, newSource);
      if (errorsAfter.length > errorsBefore) {
        return {
          content: [
            {
              type: "text",
              text:
                `Rewrite would introduce syntax errors (first at line ${errorsAfter[0]?.line}: ${errorsAfter[0]?.snippet}). ` +
                `File left unchanged. Check the rewrite template.`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      fs.writeFileSync(abs, newSource, "utf8");
      const preview = matches
        .slice(0, 5)
        .map(
          (m, i) =>
            `  line ${lines[i]}: ${firstLine(m.text())} → ${firstLine(substituteMetaVars(source, m, params.rewrite))}`
        )
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text:
              `Replaced ${matches.length} occurrence(s) in ${params.path} (lines ${lines.slice(0, 20).join(", ")}).\n` +
              preview +
              (matches.length > 5
                ? `\n  … and ${matches.length - 5} more`
                : ""),
          },
        ],
        details: { count: matches.length, lines },
      };
    },
  });

  pi.registerTool({
    name: "code_map",
    label: "Code Map",
    description:
      "Deterministic symbol index. Lists what a file or directory DEFINES: functions, classes, " +
      "methods, interfaces, types, enums, exported constants, CSS rules, each with its line number " +
      "and full signature, nested under the class or namespace that holds it. " +
      "Use it to answer 'where is X defined' and 'what is in this module' without reading whole files: " +
      "one call over a directory replaces a dozen reads. " +
      "Honours .gitignore and skips build output, vendored code and minified bundles. " +
      "`query` filters by substring; several words must all match (e.g. 'session close'), " +
      "matched against the qualified name and the signature. " +
      "Indexes .ts .tsx .js .jsx .mjs .cjs .mts .cts .py .css. " +
      "For a symbol's body, or for a language not listed, use grep.",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description: "File or directory (default: workspace root)",
        })
      ),
      query: Type.Optional(
        Type.String({
          description:
            "Space-separated substrings; all must match. Literal text, not a regex.",
        })
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!astGrepAvailable()) {
        return {
          content: [
            {
              type: "text",
              text: "code_map is unavailable: this build has no ast-grep parser. Use grep or glob instead.",
            },
          ],
          isError: true,
          details: {},
        };
      }

      const deadline = Date.now() + CALL_BUDGET_MS;
      const target = path.resolve(ctx.cwd, params.path ?? ".");
      let stats: fs.Stats;
      try {
        stats = fs.statSync(target);
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Cannot access ${params.path ?? "."}: ${(e as Error).message}`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      // A file named explicitly is indexed whatever the walk would skip.
      let scan: ScanResult;
      if (stats.isDirectory()) {
        scan = collectFiles(
          target,
          (file) => familyFor(langForFile(file) ?? "") != null,
          {
            maxFiles: MAX_FILES,
            maxDepth: MAX_DEPTH,
            timeBudgetMs: Math.min(SCAN_BUDGET_MS, deadline - Date.now()),
            ...(signal ? { signal } : {}),
          }
        );
      } else {
        const lang = langForFile(target);
        if (!lang || !familyFor(lang)) {
          return {
            content: [
              {
                type: "text",
                text:
                  `code_map does not index ${path.extname(target) || "this file type"}. ` +
                  `Indexed: ${INDEXED_EXTENSIONS.join(" ")}. Use grep for anything else.`,
              },
            ],
            isError: true,
            details: {},
          };
        }
        scan = { files: [target], overflow: 0, stoppedEarly: null };
      }

      const terms = queryTerms(params.query);
      // A directory scan shares the output between files.
      const wholeTree = scan.files.length > 1;
      const sections: string[] = [];
      const notes: string[] = [];
      let filesWithSymbols = 0;
      let totalSymbols = 0;
      let matchedSymbols = 0;
      let omittedSymbols = 0;
      let omittedFiles = 0;
      /** Symbols dropped from a file that WAS shown, as opposed to a file that was not. */
      let trimmedSymbols = 0;
      let unreadable = 0;
      let skippedContent = 0;
      let outputChars = 0;
      let capped = false;
      let aborted = false;

      let filesRead = 0;
      let ranOutOfTime = false;

      for (const file of scan.files) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }

        if (Date.now() > deadline) {
          ranOutOfTime = true;
          break;
        }

        filesRead++;

        const lang = langForFile(file);
        const family = lang ? familyFor(lang) : undefined;
        if (!lang || !family) continue;

        let source: string;
        try {
          source = fs.readFileSync(file, "utf8");
        } catch {
          unreadable++;
          continue;
        }

        if (source.length > MAX_FILE_BYTES) {
          skippedContent++;
          continue;
        }

        const usable = isIndexableContent(source);
        if (!usable.ok) {
          skippedContent++;
          continue;
        }

        let symbols: CodeSymbol[];
        try {
          symbols = symbolsIn(family, source, parseSource(lang, source).root());
        } catch {
          // A parser that throws on one file must not lose the other 300.
          unreadable++;
          continue;
        }

        totalSymbols += symbols.length;

        const matched = symbols.filter((symbol) => matchesQuery(symbol, terms));
        if (matched.length === 0) continue;

        matchedSymbols += matched.length;

        // Past the cap, keep counting so the footer can say what was left out.
        if (capped) {
          omittedSymbols += matched.length;
          omittedFiles++;
          continue;
        }

        filesWithSymbols++;
        const relative = relativeLabel(ctx.cwd, file);
        const { text, omitted } = renderCapped(matched, wholeTree);
        trimmedSymbols += omitted;
        const section = `${relative}\n${text}`;
        outputChars += section.length;
        sections.push(section);

        if (outputChars > MAX_OUTPUT_CHARS) {
          capped = true;

          // With no query there is nothing left to count; with one, the total
          // match count is the reason the caller asked.
          if (terms.length === 0) break;
        }
      }

      // Assembled before the empty case: an interrupted scan that found
      // nothing must not report itself as an empty directory.
      if (capped) {
        notes.push(
          terms.length === 0
            ? `output capped after ${filesRead} of ${scan.files.length} file(s); narrow with path, or pass a query`
            : `output capped: ${omittedSymbols} more match(es) in ${omittedFiles} unshown file(s); narrow with path or query`
        );
      }
      if (trimmedSymbols > 0) {
        notes.push(
          `${trimmedSymbols} symbol(s) trimmed from files that are shown; index one of them directly for all of it`
        );
      }
      if (scan.stoppedEarly === "files") {
        notes.push(
          `scan stopped at ${MAX_FILES} files (${scan.overflow}+ not visited); index a subdirectory for the rest`
        );
      }
      if (scan.stoppedEarly === "depth")
        notes.push(`scan stopped at depth ${MAX_DEPTH}`);
      if (scan.stoppedEarly === "time" || ranOutOfTime) {
        notes.push(
          `stopped at its ${CALL_BUDGET_MS / 1_000}s budget after ${filesRead} file(s); index a subdirectory`
        );
      }
      if (scan.stoppedEarly === "aborted" || aborted)
        notes.push("interrupted; results are partial");
      if (skippedContent > 0)
        notes.push(
          `${skippedContent} file(s) skipped as generated, minified or too large`
        );
      if (unreadable > 0)
        notes.push(`${unreadable} file(s) could not be read or parsed`);

      const footer = notes.length > 0 ? `\n\n(${notes.join("; ")})` : "";

      if (sections.length === 0) {
        const nothingIndexable =
          scan.files.length === 0 && scan.stoppedEarly === null
            ? ` Nothing here has an extension code_map indexes (${INDEXED_EXTENSIONS.join(" ")}).`
            : "";
        const text =
          terms.length > 0
            ? `No symbols matching "${params.query}". Scanned ${scan.files.length} file(s); ${totalSymbols} symbol(s) indexed. Try fewer words, or grep for a usage rather than a definition.`
            : `No symbols found. Scanned ${scan.files.length} file(s).${nothingIndexable}`;

        return {
          content: [{ type: "text", text: `${text}${footer}`.trim() }],
          details: {
            files: 0,
            symbols: 0,
            scanned: scan.files.length,
            truncated: ranOutOfTime || scan.stoppedEarly != null,
          },
        };
      }

      return {
        content: [{ type: "text", text: `${sections.join("\n\n")}${footer}` }],
        details: {
          // Files printed and matches found; the footer explains any gap.
          files: filesWithSymbols,
          symbols: matchedSymbols,
          scanned: scan.files.length,
          truncated: capped || ranOutOfTime || scan.stoppedEarly != null,
        },
      };
    },
  });
}
