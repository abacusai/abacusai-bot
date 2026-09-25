import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Knowledge injection, kept small and conditional: a capped workspace brief
 * (stack, docs, top-level dirs) once per session, and a tool usage card
 * appended to a tool's second consecutive failure, so it costs nothing when
 * things work. Ported from codingagent-lite (abacusai/codingagent-lite), MIT.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BRIEF_CHAR_CAP = 1_200;

const DOC_CANDIDATES = [
  "README.md",
  "CONTRIBUTING.md",
  ".docs/instructions.md",
  "docs/instructions.md",
];

const TOOL_CARDS: Record<string, string> = {
  edit:
    "edit usage: pass path, oldText and newText. oldText is copied VERBATIM from the file (exact " +
    "whitespace). Read the file first, keep oldText minimal but unique. To change EVERY occurrence, set " +
    "replaceAll: true rather than repeating the edit. For several changes to the SAME file, use " +
    "batch_edit once instead of calling edit repeatedly. If it keeps failing, re-read the file: its " +
    "content is not what you remember.",
  batch_edit:
    "batch_edit usage: pass path and edits[], each with oldText/newText. Every oldText is matched " +
    "against the ORIGINAL file, not against earlier edits, so the edits must not overlap: merge " +
    "nearby changes into one entry. Use it whenever one file needs more than one change.",
  batch_file_read:
    "batch_file_read usage: pass paths[] to read several files in one turn instead of one read per " +
    "file. The batch shares one output budget, so ask for the files you actually need. Use read for " +
    "one file, a region of a file (offset/limit), or an image.",
  write:
    "write replaces a whole file. Prefer edit for a change to part of one (read it first), or ast_edit " +
    "for the same structural change in many places. Replacing an existing file keeps a copy of what was " +
    "there under .abacusai-bot/backups/, and the result tells you the path to restore from.",
  ast_edit:
    "ast_edit usage: pattern must be VALID CODE in the target language, not a regex. $VAR matches one " +
    "syntax node, $$$VAR matches a list. Example: pattern `foo($$$ARGS)`, rewrite `bar($$$ARGS)`. " +
    "If nothing matches, simplify the pattern to the smallest expression that identifies the code.",
  code_map:
    "code_map usage: point it at a DIRECTORY to see what a subsystem defines, or pass query with the " +
    'words you know ("session close"). Several words all have to match, and they are literal text, ' +
    "not a regex. It indexes definitions only, in .ts .tsx .js .jsx .py .css; for a usage, a string, or " +
    "any other language, use grep.",
  run_tests:
    'run_tests usage: call with no arguments to run the whole suite, or filter: "substring" for a ' +
    "subset. Do not pass shell flags: it builds the command itself.",
  bash:
    "bash usage: non-interactive commands only; big outputs get trimmed, so pipe exploration through " +
    "grep/head/tail. For file changes use edit/batch_edit/write/ast_edit, not shell redirects.",
};

function detectStack(cwd: string): string[] {
  const facts: string[] = [];
  const read = (p: string) => {
    try {
      return fs.readFileSync(path.join(cwd, p), "utf8");
    } catch {
      return undefined;
    }
  };
  const pkgRaw = read("package.json");
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      const scripts = Object.keys(pkg.scripts ?? {}).slice(0, 8);
      facts.push(
        `Node project "${pkg.name ?? "?"}"${scripts.length ? ` (npm scripts: ${scripts.join(", ")})` : ""}`
      );
    } catch {
      facts.push("Node project (package.json present, unparseable)");
    }
  }
  if (read("pyproject.toml") !== undefined || read("setup.py") !== undefined)
    facts.push("Python project (pyproject/setup.py)");
  if (read("go.mod") !== undefined) facts.push("Go module");
  if (read("Cargo.toml") !== undefined) facts.push("Rust crate");
  return facts;
}

export default function (pi: ExtensionAPI) {
  let briefed = false;
  const consecutiveErrors = new Map<string, number>();

  pi.on("before_agent_start", async (_event, ctx) => {
    if (briefed) return;
    briefed = true;

    const stack = detectStack(ctx.cwd);
    const docs = DOC_CANDIDATES.filter((d) =>
      fs.existsSync(path.join(ctx.cwd, d))
    );
    let dirs: string[] = [];
    try {
      dirs = fs
        .readdirSync(ctx.cwd, { withFileTypes: true })
        .filter(
          (e) =>
            e.isDirectory() &&
            !e.name.startsWith(".") &&
            e.name !== "node_modules"
        )
        .map((e) => e.name + "/")
        .slice(0, 15);
    } catch {
      // unreadable cwd: skip the brief
    }
    if (stack.length === 0 && docs.length === 0 && dirs.length === 0) return;

    const parts = ["Workspace brief (auto-generated):"];
    if (stack.length > 0) parts.push(`- Stack: ${stack.join("; ")}`);
    if (dirs.length > 0) parts.push(`- Top-level dirs: ${dirs.join(" ")}`);
    if (docs.length > 0)
      parts.push(`- Docs to read before editing: ${docs.join(", ")}`);
    parts.push(
      "- Use code_map (path, or query) to locate symbols before reading whole files."
    );

    return {
      message: {
        customType: "abacusai-bot-workspace-brief",
        content: parts.join("\n").slice(0, BRIEF_CHAR_CAP),
        display: false,
      },
    };
  });

  pi.on("tool_result", async (event) => {
    if (!event.isError) {
      consecutiveErrors.set(event.toolName, 0);
      return;
    }
    const count = (consecutiveErrors.get(event.toolName) ?? 0) + 1;
    consecutiveErrors.set(event.toolName, count);
    const card = TOOL_CARDS[event.toolName];
    if (count === 2 && card) {
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: `Hint: ${card}` },
        ],
      };
    }
  });
}
