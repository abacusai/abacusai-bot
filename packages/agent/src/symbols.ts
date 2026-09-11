/**
 * The symbol index behind `code_map`, kept apart from the tool so the language
 * knowledge can be tested against source strings. One walk classifies nodes in
 * context (enclosing class, whether `export` applies, where the body starts);
 * a flat list of node kinds misses `const load = () => {}` entirely.
 */
import { firstLine, type AstGrepNode } from "./lang.js";

/**
 * The language families the index knows: ast-grep's names collapsed to the
 * granularity the classifiers work at (TypeScript and TSX share every kind).
 */
export type SymbolFamily = "ts" | "python" | "css";

export interface CodeSymbol {
  /** 1-based, to match editors and every other tool that prints a location. */
  line: number;
  /** Short tag shown in the output: `fn`, `class`, `method`, ... */
  kind: string;
  /** Bare identifier, for query matching. Empty for an anonymous default export. */
  name: string;
  /** The declaration header, whitespace collapsed, body excluded. */
  signature: string;
  /** Enclosing class / interface / namespace names, outermost first. */
  container: string[];
  exported: boolean;
}

/** ast-grep language name → the family whose classifier handles it. */
export function familyFor(lang: string): SymbolFamily | undefined {
  switch (lang) {
    case "TypeScript":
    case "Tsx":
    case "JavaScript":
      return "ts";
    case "python":
      return "python";
    case "Css":
      return "css";
    // Html parses, but "every element with an id" is a page outline, not a
    // symbol index; reported as unindexed rather than as "no symbols".
    default:
      return undefined;
  }
}

const MAX_SIGNATURE_CHARS = 140;

/** Every signature goes through here, so the cap is applied in exactly one place. */
function truncate(text: string): string {
  return text.length > MAX_SIGNATURE_CHARS
    ? `${text.slice(0, MAX_SIGNATURE_CHARS)}…`
    : text;
}

/** Child by kind, for grammars where the interesting node has no named field. */
function childOfKind(
  node: AstGrepNode,
  kinds: string[]
): AstGrepNode | undefined {
  return node.children().find((child) => kinds.includes(child.kind()));
}

function fieldOf(node: AstGrepNode, name: string): AstGrepNode | undefined {
  return node.field?.(name) ?? undefined;
}

function nameOf(node: AstGrepNode): string {
  const named = fieldOf(node, "name");
  if (named) return named.text();

  // Some grammar versions give class members no `name` field.
  const identifier = childOfKind(node, [
    "identifier",
    "type_identifier",
    "property_identifier",
    "private_property_identifier",
  ]);

  return identifier?.text() ?? "";
}

/**
 * The declaration header: from the start of the node up to its body, so a
 * wrapped parameter list prints as one line and a long function does not
 * arrive whole.
 */
export function signatureOf(
  source: string,
  node: AstGrepNode,
  bodyKinds: string[]
): string {
  const start = node.range().start.index;
  const end = bodyStart(node, bodyKinds) ?? node.range().end.index;
  const header = source.slice(start, Math.max(start, end));

  // Cutting at the body of `const x = () => {}` leaves a dangling `=`/`=>`; a
  // trailing `;` is ambient-signature noise. A trailing `:` is kept for Python.
  const collapsed = header
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(=>|=|;)\s*$/, "")
    .trim();
  const flat =
    collapsed.length > 0
      ? collapsed
      : firstLine(node.text(), MAX_SIGNATURE_CHARS);

  return truncate(flat);
}

/**
 * Where a declaration's body begins, or undefined if it has none. The second
 * lookup handles `const load = (a, b) => {...}`, whose body sits one level
 * below the declarator that carries the name.
 */
function bodyStart(node: AstGrepNode, bodyKinds: string[]): number | undefined {
  const own = fieldOf(node, "body") ?? childOfKind(node, bodyKinds);
  if (own) return own.range().start.index;

  // `value` for a declarator, `right` for an assignment.
  const value = fieldOf(node, "value") ?? fieldOf(node, "right");
  const nested = value
    ? (fieldOf(value, "body") ?? childOfKind(value, bodyKinds))
    : undefined;

  return nested?.range().start.index;
}

/** A value reduced to its shape: contents are what `read` is for. */
function summariseValue(source: string, raw: AstGrepNode): string {
  const value = unwrapValue(raw);

  if (value.kind() === "object") return "{…}";
  if (value.kind() === "array") return "[…]";

  const body = fieldOf(value, "body") ?? childOfKind(value, TS_BODY_KINDS);
  const end = body ? body.range().start.index : value.range().end.index;
  const head = source
    .slice(value.range().start.index, end)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(=>|=)\s*$/, "")
    .trim();

  return head === "" ? firstLine(value.text(), 48) : head;
}

/**
 * Every name a binding pattern introduces, with its line. Patterns nest,
 * default, rename and rest; "the identifiers actually bound, the value side
 * of a pair" is the one rule that survives all of those.
 */
function patternBindings(
  node: AstGrepNode
): Array<{ name: string; line: number }> {
  if (
    node.kind() === "identifier" ||
    node.kind() === "shorthand_property_identifier_pattern"
  ) {
    return [{ name: node.text(), line: node.range().start.line + 1 }];
  }

  const pair =
    node.kind() === "pair_pattern" ? fieldOf(node, "value") : undefined;

  if (pair != null) return patternBindings(pair);

  return node.children().flatMap((child) => {
    // Keys are not bindings: `{ a: b }` binds `b` alone.
    if (child.kind() === "property_identifier") return [];

    return patternBindings(child);
  });
}

/**
 * A constant's declaration line with the value summarised, not quoted: a
 * lookup table is worth indexing and its contents are what `read` is for.
 */
function constSignature(
  source: string,
  node: AstGrepNode,
  prefix: string
): string {
  const value = fieldOf(node, "value");
  if (!value) return `${prefix}${signatureOf(source, node, [])}`;

  const head = source
    .slice(node.range().start.index, value.range().start.index)
    .replace(/\s+/g, " ")
    .trim();
  const shape = summariseValue(source, value);

  return truncate(`${prefix}${head} ${shape}`.replace(/\s+/g, " ").trim());
}

const TS_BODY_KINDS = [
  "statement_block",
  "class_body",
  "interface_body",
  "enum_body",
  "object_type",
];

/**
 * Declaration kinds the walk names for itself, so `export default class X` is
 * not also reported as an anonymous default.
 */
const TS_NAMED_DECLARATIONS = [
  "function_declaration",
  "generator_function_declaration",
  "function_signature",
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "internal_module",
  "lexical_declaration",
  "variable_declaration",
  "ambient_declaration",
];

/** Wrappers that stand between `export default` and the value a reader cares about. */
const TS_VALUE_WRAPPERS = [
  "satisfies_expression",
  "as_expression",
  "parenthesized_expression",
  "non_null_expression",
];

/**
 * The value an `export default` carries, or undefined when the statement
 * declares a name for itself. Written as "not a keyword, not a declaration"
 * because an allow-list of value kinds goes stale the first time a grammar
 * grows a node (`satisfies_expression`).
 */
function defaultExportValue(node: AstGrepNode): AstGrepNode | undefined {
  return node
    .children()
    .find(
      (child) =>
        !["export", "default", ";", "=", "type"].includes(child.kind()) &&
        !TS_NAMED_DECLARATIONS.includes(child.kind())
    );
}

/** Past `satisfies Command`, `as const` and a wrapping paren, to the value itself. */
function unwrapValue(node: AstGrepNode): AstGrepNode {
  let current = node;

  for (
    let depth = 0;
    depth < 4 && TS_VALUE_WRAPPERS.includes(current.kind());
    depth++
  ) {
    const inner = current.children()[0];
    if (!inner) break;
    current = inner;
  }

  return current;
}

/** Function-valued nodes, i.e. what makes `const x = ...` a definition. */
const TS_FUNCTION_VALUES = [
  "arrow_function",
  "function_expression",
  "function",
  "generator_function",
];

/**
 * Whether a declarator's initialiser defines a function. One level of
 * unwrapping covers `memo(...)` / `forwardRef(...)`; deeper than that a config
 * object full of callbacks would qualify.
 */
function isFunctionValue(value: AstGrepNode | undefined): boolean {
  if (!value) return false;
  if (TS_FUNCTION_VALUES.includes(value.kind())) return true;

  if (value.kind() === "call_expression") {
    const args = childOfKind(value, ["arguments"]);
    return (
      args?.children().some((arg) => TS_FUNCTION_VALUES.includes(arg.kind())) ??
      false
    );
  }

  return false;
}

/**
 * The function an immediately-invoked expression wraps, if that is what this
 * is. `(function () { ... })()` around a whole file IS the module, so the walk
 * must go through it rather than stop at its body.
 */
function immediatelyInvokedFunction(
  node: AstGrepNode
): AstGrepNode | undefined {
  if (node.kind() !== "call_expression") return undefined;

  const callee = node.children()[0];
  if (!callee) return undefined;

  if (TS_FUNCTION_VALUES.includes(callee.kind())) return callee;

  return callee.kind() === "parenthesized_expression"
    ? callee
        .children()
        .find((child) => TS_FUNCTION_VALUES.includes(child.kind()))
    : undefined;
}

/** The property a member assignment defines: `bar` in `Foo.prototype.bar = fn`. */
function assignedMemberName(target: AstGrepNode): string {
  return target.kind() === "member_expression"
    ? (fieldOf(target, "property")?.text() ?? "")
    : "";
}

/** `SCREAMING_SNAKE`, the one naming convention that reliably marks a module constant. */
function isConstantCase(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name) && name.length > 1;
}

interface WalkState {
  source: string;
  out: CodeSymbol[];
  container: string[];
  exported: boolean;
  /** Set on entering any function body, so locals inside one are not symbols. */
  inFunction: boolean;
  /** The `const` / `let` / `var` of the parent statement, for the signature. */
  keyword: string;
}

function push(
  state: WalkState,
  node: AstGrepNode,
  kind: string,
  name: string,
  bodyKinds: string[],
  prefix = ""
): void {
  state.out.push({
    line: node.range().start.line + 1,
    kind,
    name,
    signature: `${prefix}${signatureOf(state.source, node, bodyKinds)}`,
    container: [...state.container],
    exported: state.exported,
  });
}

/** One node still to visit, and the state it inherited. */
interface WalkItem {
  node: AstGrepNode;
  state: WalkState;
}

/**
 * Drive a walker from an explicit worklist instead of the call stack: tree
 * depth follows source shape, and `1 + 1 + 1 + …` nests one node per term,
 * deep enough to overflow the stack. Each visit returns the children it wants
 * walked.
 */
function drive(
  root: AstGrepNode,
  rootState: WalkState,
  visit: (node: AstGrepNode, state: WalkState) => WalkItem[]
): void {
  const pending: WalkItem[] = [{ node: root, state: rootState }];

  while (pending.length > 0) {
    const item = pending.pop();
    if (item == null) break;

    const next = visit(item.node, item.state);
    // Pushed in reverse so they pop in source order.
    for (let i = next.length - 1; i >= 0; i -= 1) pending.push(next[i]!);
  }
}

function walkTs(root: AstGrepNode, rootState: WalkState): void {
  drive(root, rootState, visitTs);
}

function visitTs(node: AstGrepNode, state: WalkState): WalkItem[] {
  // Nothing inside a function body is module surface; stopping there keeps a
  // test file from mapping as a list of every `it`.
  if (state.inFunction) return [];

  const kind = node.kind();
  let nextContainer = state.container;
  let nextExported = state.exported;
  let nextInFunction: boolean = state.inFunction;
  let nextKeyword = state.keyword;

  // Any function body, named or not, makes what is inside it local.
  if (TS_FUNCTION_VALUES.includes(kind)) nextInFunction = true;

  // ...unless it is invoked on the spot to BE the module. Walked here so the
  // wrapper contributes no symbol of its own.
  const wrapper = immediatelyInvokedFunction(node);

  if (wrapper) {
    return wrapper
      .children()
      .map((child) => ({ node: child, state: { ...state, exported: false } }));
  }

  switch (kind) {
    case "export_statement": {
      // `export` applies to the declaration inside it, so the flag travels down.
      nextExported = true;

      // `export default <expression>` binds no name; it is listed as `default`
      // because that is what an importer has to call it.
      const value = defaultExportValue(node);

      if (value) {
        state.out.push({
          line: node.range().start.line + 1,
          kind: "default",
          name: "default",
          signature: truncate(
            `export default ${summariseValue(state.source, value)}`
          ),
          container: [...state.container],
          exported: true,
        });
      }

      break;
    }

    case "lexical_declaration":
    case "variable_declaration": {
      const keyword = node.children()[0]?.text() ?? "";
      nextKeyword = /^(const|let|var)$/.test(keyword) ? `${keyword} ` : "";
      break;
    }

    case "function_declaration":
    case "generator_function_declaration":
    case "function_signature": {
      const name = nameOf(node);
      push(state, node, "fn", name || "default", TS_BODY_KINDS);
      nextInFunction = true;
      break;
    }

    case "class_declaration":
    case "abstract_class_declaration": {
      const name = nameOf(node);
      push(state, node, "class", name || "default", TS_BODY_KINDS);
      nextContainer = [...state.container, name || "default"];
      nextExported = false;
      break;
    }

    case "interface_declaration": {
      const name = nameOf(node);
      push(state, node, "interface", name, TS_BODY_KINDS);
      nextContainer = [...state.container, name];
      nextExported = false;
      break;
    }

    case "internal_module": {
      // `namespace Foo { ... }`. Members re-declare their own export status.
      const name = nameOf(node);
      push(state, node, "namespace", name, TS_BODY_KINDS);
      nextContainer = [...state.container, name];
      nextExported = false;
      break;
    }

    case "enum_declaration":
      push(state, node, "enum", nameOf(node), TS_BODY_KINDS);
      return [];

    case "type_alias_declaration":
      push(state, node, "type", nameOf(node), TS_BODY_KINDS);
      return [];

    case "method_definition":
    case "method_signature":
    case "abstract_method_signature":
      push(state, node, "method", nameOf(node), TS_BODY_KINDS);
      nextInFunction = true;
      break;

    // `handleClick = () => {}` as a class field is a method in everything but
    // the grammar. A field with a plain value is not, and is left out.
    case "public_field_definition":
    case "field_definition": {
      if (isFunctionValue(fieldOf(node, "value"))) {
        push(state, node, "method", nameOf(node), TS_BODY_KINDS);
        nextInFunction = true;
        break;
      }
      return [];
    }

    case "variable_declarator": {
      // A pattern names several symbols: `export const { a, b } = paths()`
      // exports both. Each bound name is its own entry; the pattern itself is
      // never printed.
      const named = fieldOf(node, "name");
      const name = named?.kind() === "identifier" ? named.text() : "";
      const value = fieldOf(node, "value");

      if (named != null && name === "" && state.exported) {
        for (const bound of patternBindings(named)) {
          state.out.push({
            // The binding's own line: a multi-line pattern exports each name
            // where it is written.
            line: bound.line,
            kind: "const",
            name: bound.name,
            signature: `${state.keyword}${bound.name}`,
            container: [...state.container],
            exported: true,
          });
        }

        break;
      }

      if (isFunctionValue(value)) {
        if (name !== "")
          push(state, node, "fn", name, TS_BODY_KINDS, state.keyword);
        nextInFunction = true;
        break;
      }

      // A module-level table is looked up by name; a plain local is not, so it
      // must be exported or CONSTANT_CASE to count.
      if (name !== "" && (state.exported || isConstantCase(name))) {
        state.out.push({
          line: node.range().start.line + 1,
          kind: "const",
          name,
          signature: constSignature(state.source, node, state.keyword),
          container: [...state.container],
          exported: state.exported,
        });
      }

      break;
    }

    // `module.exports.run = fn`, `Foo.prototype.bar = fn`: assignment is how
    // CommonJS and prototype-style JavaScript define names.
    case "assignment_expression": {
      const target = node.children()[0];
      const name = target ? assignedMemberName(target) : "";

      if (name !== "" && isFunctionValue(fieldOf(node, "right"))) {
        push(state, node, "fn", name, TS_BODY_KINDS);
        nextInFunction = true;
      }

      break;
    }

    // `{ onSelect: () => {} }` handler tables; only the function-valued pairs.
    case "pair": {
      if (!isFunctionValue(fieldOf(node, "value"))) break;

      const key = fieldOf(node, "key");
      push(state, node, "fn", key?.text() ?? "", TS_BODY_KINDS);
      nextInFunction = true;
      break;
    }

    default:
      break;
  }

  const childState: WalkState = {
    ...state,
    container: nextContainer,
    exported: nextExported,
    inFunction: nextInFunction,
    keyword: nextKeyword,
  };

  return node.children().map((child) => ({ node: child, state: childState }));
}

const PY_BODY_KINDS = ["block"];

function walkPython(root: AstGrepNode, rootState: WalkState): void {
  drive(root, rootState, visitPython);
}

function visitPython(node: AstGrepNode, state: WalkState): WalkItem[] {
  if (state.inFunction) return [];

  const kind = node.kind();
  let nextContainer = state.container;
  let nextInFunction: boolean = state.inFunction;

  if (kind === "lambda") nextInFunction = true;

  switch (kind) {
    case "function_definition": {
      push(
        state,
        node,
        state.container.length > 0 ? "method" : "fn",
        nameOf(node),
        PY_BODY_KINDS
      );
      nextInFunction = true;
      break;
    }

    case "class_definition": {
      const name = nameOf(node);
      push(state, node, "class", name, PY_BODY_KINDS);
      nextContainer = [...state.container, name];
      break;
    }

    case "assignment": {
      // Module-level constants and `handler = lambda ...`.
      const left = fieldOf(node, "left");
      const name = left?.kind() === "identifier" ? left.text() : "";
      const isLambda = fieldOf(node, "right")?.kind() === "lambda";

      if (name !== "" && (isLambda || isConstantCase(name))) {
        push(state, node, isLambda ? "fn" : "const", name, PY_BODY_KINDS);
      }

      break;
    }

    default:
      break;
  }

  const childState: WalkState = {
    ...state,
    container: nextContainer,
    inFunction: nextInFunction,
  };

  return node.children().map((child) => ({ node: child, state: childState }));
}

function walkCss(root: AstGrepNode, rootState: WalkState): void {
  drive(root, rootState, visitCss);
}

function visitCss(node: AstGrepNode, state: WalkState): WalkItem[] {
  const kind = node.kind();

  if (kind === "rule_set") {
    const selectors = childOfKind(node, ["selectors"]);
    const text = selectors ? selectors.text().replace(/\s+/g, " ").trim() : "";

    if (text !== "") {
      state.out.push({
        line: node.range().start.line + 1,
        kind: "rule",
        name: text,
        signature: truncate(text),
        container: [...state.container],
        exported: false,
      });
    }

    // Native CSS nesting: `.card { .title { … } }` is most of a modern sheet.
    const block = childOfKind(node, ["block"]);

    if (block) {
      const nested = text === "" ? state.container : [...state.container, text];

      return block.children().map((child) => ({
        node: child,
        state: { ...state, container: nested },
      }));
    }

    return [];
  }

  if (kind === "keyframes_statement") {
    const name = childOfKind(node, ["keyframes_name"])?.text() ?? "";
    state.out.push({
      line: node.range().start.line + 1,
      kind: "keyframes",
      name,
      signature: `@keyframes ${name}`,
      container: [...state.container],
      exported: false,
    });

    return [];
  }

  return node.children().map((child) => ({ node: child, state }));
}

/**
 * Every symbol in one parsed file, sorted by line then depth so a container
 * precedes what it contains. Deliberately no deduplication: the walk visits
 * each node once, and two overloads on one line or `.a {} .a {}` are distinct
 * declarations that a (line, container, name, kind) filter would drop.
 */
export function symbolsIn(
  family: SymbolFamily,
  source: string,
  root: AstGrepNode
): CodeSymbol[] {
  const state: WalkState = {
    source,
    out: [],
    container: [],
    exported: false,
    inFunction: false,
    keyword: "",
  };

  if (family === "ts") walkTs(root, state);
  else if (family === "python") walkPython(root, state);
  else walkCss(root, state);

  return state.out.sort(
    (a, b) => a.line - b.line || a.container.length - b.container.length
  );
}

/**
 * Whether a symbol matches a query: terms ANDed, case-insensitive, against the
 * qualified name and signature. Substrings, not patterns, so a model that
 * writes `.*` gets the literal rather than a silent regex.
 */
export function matchesQuery(symbol: CodeSymbol, terms: string[]): boolean {
  if (terms.length === 0) return true;

  // No leading separator, or a query for "." would match every symbol.
  const qualified = [...symbol.container, symbol.name]
    .filter((part) => part !== "")
    .join(".");
  const haystack = `${qualified} ${symbol.signature}`.toLowerCase();

  return terms.every((term) => haystack.includes(term));
}

export function queryTerms(query: string | undefined): string[] {
  return (query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/** One file's symbols, indented by nesting so a class reads as a heading. */
export function renderSymbols(symbols: CodeSymbol[]): string {
  const width = Math.max(
    ...symbols.map((symbol) => String(symbol.line).length),
    1
  );

  return symbols
    .map((symbol) => {
      const line = String(symbol.line).padStart(width);
      const indent = "  ".repeat(symbol.container.length);
      // `export` sits on a parent node, so it is reattached here.
      const prefix = symbol.exported ? "export " : "";

      return `  ${line}  ${indent}${prefix}${symbol.signature}`;
    })
    .join("\n");
}
