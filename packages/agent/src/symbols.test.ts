/**
 * What `code_map` can see.
 *
 * These are written as "a file shaped like this, and the names a reader would
 * expect back", because that is the only property that matters: a symbol index
 * that misses a third of a modern TypeScript file is worse than no index, since
 * the model reads the gap as "not defined here" and goes looking somewhere else.
 *
 * Every case here is a shape that the previous kind-list implementation got
 * wrong.
 */
import { describe, expect, it } from "vitest";

import { langForFile, parseSource } from "./lang.js";
import {
  familyFor,
  matchesQuery,
  queryTerms,
  renderSymbols,
  symbolsIn,
  type CodeSymbol,
  type SymbolFamily,
} from "./symbols.js";

function index(file: string, source: string): CodeSymbol[] {
  const lang = langForFile(file);
  if (!lang) throw new Error(`no parser for ${file}`);

  const family = familyFor(lang);
  if (!family) throw new Error(`no symbol family for ${lang}`);

  return symbolsIn(
    family as SymbolFamily,
    source,
    parseSource(lang, source).root()
  );
}

const names = (symbols: CodeSymbol[]): string[] =>
  symbols.map((symbol) =>
    [...symbol.container, symbol.name].filter(Boolean).join(".")
  );

const find = (symbols: CodeSymbol[], name: string): CodeSymbol | undefined =>
  symbols.find((symbol) => symbol.name === name);

describe("TypeScript declarations", () => {
  it("finds a function however it was written", () => {
    const symbols = index(
      "a.ts",
      `
export function declared() {}
export const arrow = () => {}
export const expression = function () {}
const generator = function* () {}
export async function asynchronous() {}
function* declaredGenerator() {}
export default function anonymousDefault() {}
`
    );

    expect(names(symbols)).toEqual([
      "declared",
      "arrow",
      "expression",
      "generator",
      "asynchronous",
      "declaredGenerator",
      "anonymousDefault",
    ]);
  });

  it("finds an abstract class and its members, which the kind list missed entirely", () => {
    const symbols = index(
      "a.ts",
      `
export abstract class Base<T> implements Runner {
  static create(): Base<unknown> { return null! }
  abstract run(): Promise<void>
  protected async stop(): Promise<void> {}
  handle = () => {}
  get value(): number { return 1 }
}
`
    );

    expect(names(symbols)).toEqual([
      "Base",
      "Base.create",
      "Base.run",
      "Base.stop",
      "Base.handle",
      "Base.value",
    ]);
  });

  it("qualifies a method by its class, so twelve run()s are twelve names", () => {
    const symbols = index("a.ts", "class A { run() {} }\nclass B { run() {} }");

    expect(names(symbols)).toEqual(["A", "A.run", "B", "B.run"]);
  });

  it("keeps a wrapped signature on one line and stops at the body", () => {
    const symbols = index(
      "a.ts",
      `
export async function load(
  first: string,
  second: number,
): Promise<Config> {
  return null!
}
`
    );

    expect(find(symbols, "load")?.signature).toBe(
      "async function load( first: string, second: number, ): Promise<Config>"
    );
  });

  it("prints an arrow function as a signature, not as its body", () => {
    const symbols = index(
      "a.ts",
      "export const load = async (path: string): Promise<Config> => read(path)"
    );

    expect(find(symbols, "load")?.signature).toBe(
      "const load = async (path: string): Promise<Config>"
    );
  });

  it("reads through a wrapper call, which is how a component is declared", () => {
    const symbols = index(
      "a.tsx",
      `
export const Card = memo(function Card() { return null })
export const Input = React.forwardRef((props, ref) => null)
export const notAFunction = compute(1, 2)
`
    );

    expect(names(symbols)).toContain("Card");
    expect(names(symbols)).toContain("Input");
    // Still listed (it is an exported module constant) but as a const, and
    // that distinction is the point of the unwrapping.
    expect(find(symbols, "notAFunction")?.kind).toBe("const");
  });

  it("records interfaces, types, enums and namespaces with their members", () => {
    const symbols = index(
      "a.ts",
      `
export interface Session { start(): void; id: string }
export type Handler<T> = (value: T) => void
export enum Level { Debug }
export namespace Registry { export function get() {} }
`
    );

    expect(names(symbols)).toEqual([
      "Session",
      "Session.start",
      "Handler",
      "Level",
      "Registry",
      "Registry.get",
    ]);
  });

  it("lists a module table but not a local variable", () => {
    const symbols = index(
      "a.ts",
      `
export const TOOLSETS = [1, 2]
const RETRIES = 3
const helper = 'not exported, not a constant'
export function run() {
  const LOCAL_CACHE = new Map()
  const inner = () => {}
  return inner
}
`
    );

    expect(names(symbols)).toEqual(["TOOLSETS", "RETRIES", "run"]);
    expect(names(symbols)).not.toContain("LOCAL_CACHE");
    expect(names(symbols)).not.toContain("inner");
    expect(names(symbols)).not.toContain("helper");
  });

  it("stops at a function body, so a test file is not a list of every it()", () => {
    const symbols = index(
      "a.test.ts",
      `
describe('thing', () => {
  it('works', () => {})
  const fixture = () => ({})
})
export function helper() {}
`
    );

    expect(names(symbols)).toEqual(["helper"]);
  });

  it("summarises a lookup table rather than quoting it", () => {
    const symbols = index(
      "a.ts",
      "export const KEYS: Record<string, number> = { a: 1, b: 2, c: 3 }"
    );

    expect(find(symbols, "KEYS")?.signature).toBe(
      "export const KEYS: Record<string, number> = {…}".replace("export ", "")
    );
  });

  it("finds handlers declared as object properties", () => {
    const symbols = index(
      "a.ts",
      `
export const routes = {
  onOpen: () => {},
  onClose() {},
  timeout: 30,
}
`
    );

    expect(names(symbols)).toContain("onOpen");
    expect(names(symbols)).toContain("onClose");
    expect(names(symbols)).not.toContain("timeout");
  });

  it("indexes each exported destructured name, never the pattern", () => {
    const symbols = index(
      "a.ts",
      'export const { first, second } = require("x")'
    );

    // `export const { a, b } = …` exports both names, and indexing nothing for
    // it made a whole module's exports invisible to every symbol lookup.
    // Printing `{ first, second }` as one entry is still wrong, so each name
    // stands on its own.
    expect(symbols.map((symbol) => symbol.name)).toEqual(["first", "second"]);
    expect(symbols.every((symbol) => symbol.exported)).toBe(true);
  });

  it("binds the renamed half of a pair, not the key", () => {
    const symbols = index("a.ts", 'export const { a: renamed } = require("x")');

    expect(symbols.map((symbol) => symbol.name)).toEqual(["renamed"]);
  });

  it("leaves a local destructuring alone", () => {
    // Unexported, so it is neither a definition anyone looks up nor a line
    // worth spending in the map.
    expect(index("a.ts", 'const { first } = require("x")')).toEqual([]);
  });

  it("marks what is exported", () => {
    const symbols = index(
      "a.ts",
      "export function outside() {}\nfunction inside() {}"
    );

    expect(find(symbols, "outside")?.exported).toBe(true);
    expect(find(symbols, "inside")?.exported).toBe(false);
  });

  it("indexes a declaration file, where every symbol is a signature", () => {
    const symbols = index(
      "a.ts",
      "export declare function connect(url: string): Socket;\nexport declare class Pool {}"
    );

    expect(names(symbols)).toEqual(["connect", "Pool"]);
  });

  it("still reports what it can from a file that does not parse", () => {
    const symbols = index(
      "a.ts",
      "export function fine() {}\nfunction broken( {\n"
    );

    expect(names(symbols)).toContain("fine");
  });

  it("finds TSX components", () => {
    const symbols = index(
      "a.tsx",
      "export const Panel = ({ title }: Props) => <div>{title}</div>"
    );

    expect(names(symbols)).toEqual(["Panel"]);
  });

  it("finds plain JavaScript, including CommonJS shapes", () => {
    const symbols = index(
      "a.js",
      'const path = require("path")\nfunction main() {}\nmodule.exports = { main }'
    );

    expect(names(symbols)).toContain("main");
  });

  it("names a default export, whatever it carries", () => {
    // A config file or a component whose entire surface is `export default`
    // used to index as nothing at all.
    expect(index("a.ts", "export default [1, 2]")[0]).toMatchObject({
      kind: "default",
      name: "default",
      signature: "export default […]",
    });
    expect(index("a.ts", "export default () => {}")[0]?.signature).toBe(
      "export default ()"
    );
    // `satisfies` and `as const` wrap the value in a node of their own. An
    // allow-list of value kinds missed every command module written this way.
    expect(
      index("a.ts", 'export default {\n  name: "diff",\n} satisfies Command')[0]
        ?.signature
    ).toBe("export default {…}");
    expect(index("a.ts", "export default [1] as const")[0]?.signature).toBe(
      "export default […]"
    );
    expect(
      index("a.ts", "export default defineConfig({ plugins: [] })")[0]
        ?.signature
    ).toBe("export default defineConfig({ plugins: [] })");
  });

  it("keeps two declarations that share a line, a name and a kind", () => {
    // Overloads. A dedupe filter keyed on (line, container, name, kind) treated
    // these as one declaration and dropped the second, which is why there is
    // no such filter: it never removed a real duplicate in 5,610 files, and the
    // only things it ever removed were real.
    const symbols = index(
      "a.ts",
      "declare function f(): void; declare function f(x: number): void;"
    );

    expect(symbols).toHaveLength(2);
    expect(symbols.map((symbol) => symbol.signature)).toEqual([
      "function f(): void",
      "function f(x: number): void",
    ]);
  });

  it("names an anonymous default export rather than leaving it blank", () => {
    // Anonymous, so there is no declaration node to name: it arrives as the
    // value of the export, and `default` is what an importer has to call it.
    expect(index("a.ts", "export default function () {}")[0]).toMatchObject({
      kind: "default",
      name: "default",
      signature: "export default function ()",
    });
    expect(index("a.ts", "export default class {}")[0]?.signature).toBe(
      "export default class"
    );
  });

  it("drops the trailing semicolon of an ambient signature", () => {
    expect(
      index("a.ts", "declare function connect(url: string): Socket;")[0]
        ?.signature
    ).toBe(
      "declare function connect(url: string): Socket".replace("declare ", "")
    );
  });

  it("does not report a named default export twice", () => {
    // `export default class X` names itself; emitting an anonymous `default`
    // alongside it would list one declaration under two names.
    expect(names(index("a.ts", "export default class Widget {}"))).toEqual([
      "Widget",
    ]);
    expect(names(index("a.ts", "export default function run() {}"))).toEqual([
      "run",
    ]);
  });

  it("finds a function defined by assignment, as CommonJS and prototypes do", () => {
    const symbols = index(
      "a.js",
      `
module.exports.run = function (first, second) {
  return first
}
Runner.prototype.stop = () => {}
window.handler = 41
`
    );

    expect(names(symbols)).toEqual(["run", "stop"]);
    expect(find(symbols, "run")?.signature).toBe(
      "module.exports.run = function (first, second)"
    );
  });

  it("walks into a module wrapped in an immediately-invoked function", () => {
    // The body of an IIFE is a function body, technically. Treating it as one
    // returned nothing for a whole style of JavaScript.
    const symbols = index(
      "a.js",
      `
(function () {
  function helper() {}
  const CACHE = new Map()
})()
`
    );

    expect(names(symbols)).toEqual(["helper", "CACHE"]);
  });

  it("walks into an async IIFE too", () => {
    expect(
      names(index("a.ts", "(async () => {\n  function inner() {}\n})()"))
    ).toEqual(["inner"]);
  });

  it("caps even a signature built from a huge type annotation", () => {
    // The cap lived in one code path and not the other, so a constant carrying
    // a forty-field inline type printed 531 characters into the map.
    const fields = Array.from(
      { length: 40 },
      (_, index) => `field${index}: string`
    ).join("; ");
    const symbols = index(
      "a.ts",
      `export const state: { ${fields} } = { a: 1 }`
    );

    expect(symbols[0]!.signature.length).toBeLessThanOrEqual(141);
    expect(symbols[0]!.signature.endsWith("…")).toBe(true);
  });
});

describe("Python declarations", () => {
  it("separates functions from methods and follows decorators", () => {
    const symbols = index(
      "a.py",
      `
MAX_RETRIES = 3

class Session(Base):
    @property
    def identifier(self):
        ...

    async def close(self):
        ...

@retry
def connect(url):
    ...

def _helper():
    inner_local = 1
    return inner_local
`
    );

    expect(names(symbols)).toEqual([
      "MAX_RETRIES",
      "Session",
      "Session.identifier",
      "Session.close",
      "connect",
      "_helper",
    ]);
    expect(find(symbols, "close")?.kind).toBe("method");
    expect(find(symbols, "connect")?.kind).toBe("fn");
  });

  it("finds a lambda assigned a name", () => {
    const symbols = index(
      "a.py",
      "handler = lambda event: event\nnot_a_symbol = 1"
    );

    expect(names(symbols)).toEqual(["handler"]);
  });

  it("keeps a wrapped def readable", () => {
    const symbols = index(
      "a.py",
      "def run(\n    first,\n    second,\n):\n    pass"
    );

    expect(find(symbols, "run")?.signature).toBe("def run( first, second, ):");
  });
});

describe("CSS rules", () => {
  it("keeps two identical selectors written on one line", () => {
    const symbols = index("a.css", ".a { color: red } .a { color: blue }");

    expect(symbols).toHaveLength(2);
  });

  it("indexes a rule nested inside another, which modern CSS is full of", () => {
    const symbols = index(
      "a.css",
      ".card {\n  color: red;\n  .title { font-weight: 700 }\n}"
    );

    expect(names(symbols)).toEqual([".card", ".card..title"]);
  });

  it("indexes selectors and keyframes, including nested ones", () => {
    const symbols = index(
      "a.css",
      `
.button, .button--primary { color: red }
@media (min-width: 40rem) {
  .layout { display: grid }
}
@keyframes spin { from { opacity: 0 } }
`
    );

    expect(names(symbols)).toEqual([
      ".button, .button--primary",
      ".layout",
      "spin",
    ]);
  });
});

describe("queries", () => {
  const symbols = index(
    "a.ts",
    "export class SessionManager { close(): void {} }\nexport function openSocket() {}"
  );

  it("splits on whitespace and requires every term", () => {
    expect(queryTerms("  session   close ")).toEqual(["session", "close"]);
    expect(
      symbols
        .filter((symbol) => matchesQuery(symbol, queryTerms("session close")))
        .map((s) => s.name)
    ).toEqual(["close"]);
  });

  it("matches the container as well as the name", () => {
    expect(
      symbols.filter((symbol) =>
        matchesQuery(symbol, queryTerms("sessionmanager"))
      ).length
    ).toBe(2);
  });

  it("is case-insensitive and matches signatures", () => {
    expect(
      symbols
        .filter((symbol) => matchesQuery(symbol, queryTerms("SOCKET")))
        .map((s) => s.name)
    ).toEqual(["openSocket"]);
  });

  it("treats an empty query as no filter", () => {
    expect(queryTerms(undefined)).toEqual([]);
    expect(symbols.every((symbol) => matchesQuery(symbol, []))).toBe(true);
  });

  it("matches regex characters literally rather than as a pattern", () => {
    expect(
      symbols.some((symbol) => matchesQuery(symbol, queryTerms(".*")))
    ).toBe(false);
  });

  it("does not match every uncontained symbol on a bare separator", () => {
    // The qualified name used to be built as `.name` for a top-level symbol, so
    // a query of "." matched the whole repository.
    expect(
      symbols
        .filter((symbol) => matchesQuery(symbol, queryTerms(".")))
        .map((s) => s.name)
    ).toEqual(["close"]);
  });
});

describe("rendering", () => {
  it("indents members under their container and aligns line numbers", () => {
    const symbols = index(
      "a.ts",
      ["", "export class Runner {", "  start() {}", "}"].join("\n")
    );

    expect(renderSymbols(symbols)).toBe(
      ["  2  export class Runner", "  3    start()"].join("\n")
    );
  });

  it("pads to the widest line number so the column stays straight", () => {
    const source = `${"\n".repeat(9)}export function late() {}`;

    expect(renderSymbols(index("a.ts", source))).toContain(
      "  10  export function late()"
    );
  });
});
