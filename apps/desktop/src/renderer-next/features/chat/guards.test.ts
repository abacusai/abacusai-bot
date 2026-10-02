/**
 * R2-T30 (spec 02 §3.4, §4.5, F11, F16; extends R1-T15): an AST scan of
 * renderer-next. No call of the legacy `agent.respondPermission` /
 * `agent.queue.*`, of a `ChatClient` request method (`sendMessage`,
 * `append`, `reload`, `addToolResult`, `addToolApprovalResponse`,
 * `resumeInterrupts*`, `resolveInterrupts`, `stop`, `attach`, `detach`)
 * anywhere, of anything but the receive-side client methods inside
 * `runtime/`, no `useChat`, no named `temml` import, and the chat feature
 * imports no other feature.
 */
import { parseAst } from "rolldown/parseAst";
import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(
  [
    "../../**/*.{ts,tsx}",
    "!../../**/*.d.ts",
    "!../../routeTree.gen.ts",
    "!../../**/*.test.{ts,tsx}",
  ],
  {
    query: "?raw",
    import: "default",
    eager: true,
  }
);

type Node = { type: string; [key: string]: unknown };

const walk = (node: unknown, visit: (node: Node) => void): void => {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const typed = node as Node;
  if (typeof typed.type === "string") visit(typed);
  for (const value of Object.values(typed)) walk(value, visit);
};

const files = Object.entries(sources).map(([path, source]) => ({
  path: path.startsWith("./")
    ? `features/chat/${path.slice(2)}`
    : path.replace(/^(\.\.\/)+/, ""),
  ast: parseAst(source, { lang: path.endsWith(".tsx") ? "tsx" : "ts" }, path),
}));

const memberPath = (node: Node): string[] => {
  if (node.type === "Identifier") return [String(node.name)];
  if (node.type === "MemberExpression") {
    const property = node.property as Node;
    return [
      ...memberPath(node.object as Node),
      String(node.computed ? property.value : property.name),
    ];
  }
  return ["?"];
};

const REQUEST_METHODS = new Set([
  "sendMessage",
  "append",
  "reload",
  "addToolResult",
  "addToolApprovalResponse",
  "resumeInterrupts",
  "resumeInterruptsUnsafe",
  "resolveInterrupts",
  "attach",
  "detach",
]);

const calls = () => {
  const found: Array<{ file: string; path: string[] }> = [];
  for (const file of files)
    walk(file.ast, (node) => {
      if (node.type !== "CallExpression") return;
      const callee = node.callee as Node;
      if (callee.type === "MemberExpression")
        found.push({ file: file.path, path: memberPath(callee) });
    });
  return found;
};

const importsOf = (ast: unknown) => {
  const found: Array<{ source: string; named: string[] }> = [];
  walk(ast, (node) => {
    if (node.type !== "ImportDeclaration") return;
    const specifiers = (node.specifiers as Node[])
      .filter((s) => s.type === "ImportSpecifier")
      .map((s) => String((s.imported as Node).name));
    found.push({
      source: String((node.source as { value: string }).value),
      named: specifiers,
    });
  });
  return found;
};

describe("R2-T30 chat guards", () => {
  it("scans the tree", () => {
    expect(
      files.some((file) =>
        file.path.startsWith("features/chat/runtime/session.ts")
      )
    ).toBe(true);
  });

  it("never calls the legacy agent permission or queue commands", () => {
    const hits = calls()
      .filter(({ path }) => {
        const index = path.indexOf("agent");
        return (
          index !== -1 &&
          (path[index + 1] === "respondPermission" ||
            path[index + 1] === "queue")
        );
      })
      .map(({ file, path }) => `${file}: ${path.join(".")}`);
    expect(hits).toEqual([]);
  });

  it("never calls a ChatClient request method, or stop on a handle", () => {
    const hits = calls()
      // Receivers that can be a ChatClient, a UseChatReturn or a SubagentHandle.
      .filter(({ path }) =>
        path
          .slice(0, -1)
          .some((part) => /client|chat|host|handle|subagent/i.test(part))
      )
      .filter(
        ({ path }) =>
          REQUEST_METHODS.has(path.at(-1)!) || path.at(-1) === "stop"
      )
      .map(({ file, path }) => `${file}: ${path.join(".")}`);
    expect(hits).toEqual([]);
  });

  it("inside runtime/, the client is only subscribed, read, re-paged and disposed", () => {
    const allowed = new Set([
      "subscribe",
      "unsubscribe",
      "dispose",
      "getMessages",
      "getSubagents",
      "setMessagesManually",
    ]);
    const hits = calls()
      .filter(
        ({ file, path }) =>
          file.startsWith("features/chat/runtime/") &&
          path.includes("client") &&
          !allowed.has(path.at(-1)!) &&
          path.at(-2) === "client"
      )
      .map(({ file, path }) => `${file}: ${path.join(".")}`);
    expect(hits).toEqual([]);
  });

  it("request methods cannot be destructured or accessed through computed keys in the kit", () => {
    const hits: string[] = [];
    for (const file of files.filter((f) => f.path.startsWith("features/chat/")))
      walk(file.ast, (node) => {
        if (node.type === "ObjectPattern")
          for (const entry of node.properties as Node[]) {
            const key = entry.key as Node | undefined;
            if (
              key != null &&
              REQUEST_METHODS.has(String(key.name ?? key.value))
            )
              hits.push(file.path);
          }
        if (
          node.type === "MemberExpression" &&
          node.computed &&
          REQUEST_METHODS.has(String((node.property as Node).value))
        )
          hits.push(file.path);
      });
    expect(hits).toEqual([]);
  });

  it("no useChat, no named temml import, no other feature from the chat kit", () => {
    const hits: string[] = [];
    for (const file of files)
      for (const { source, named } of importsOf(file.ast)) {
        if (named.includes("useChat")) hits.push(`${file.path}: useChat`);
        if (source === "temml" && named.length > 0)
          hits.push(`${file.path}: named temml import`);
        if (
          file.path.startsWith("features/chat/") &&
          /^#next\/features\/(?!chat)/.test(source)
        )
          hits.push(`${file.path}: ${source}`);
      }
    expect(hits).toEqual([]);
  });
});
