/**
 * The RFC 6902 subset `STATE_DELTA` uses (spec 02 §4.3): `add`, `replace`
 * and `remove` on object paths, JSON Pointer unescaping (`~1` → `/`,
 * `~0` → `~`), and the array index `-`. Pure: the input is never mutated.
 * Returns null for anything else (another op, a path into a missing
 * parent); the store then waits for a fresh snapshot.
 */
export interface PatchOp {
  op: string;
  path: string;
  value?: unknown;
}

type Container = Record<string, unknown> | unknown[];

const FAIL = Symbol("patch-failed");

const unescapeToken = (token: string): string =>
  token.replaceAll("~1", "/").replaceAll("~0", "~");

const parsePointer = (path: string): string[] | null => {
  if (path === "") return [];
  if (!path.startsWith("/")) return null;
  return path.slice(1).split("/").map(unescapeToken);
};

const isContainer = (value: unknown): value is Container =>
  value != null && typeof value === "object";

const copyOf = (value: Container): Container =>
  Array.isArray(value) ? [...value] : { ...value };

const read = (parent: Container, token: string): unknown =>
  Array.isArray(parent) ? parent[Number(token)] : parent[token];

const write = (parent: Container, token: string, value: unknown): void => {
  if (Array.isArray(parent)) parent[Number(token)] = value;
  else parent[token] = value;
};

const applyArray = (
  parent: unknown[],
  last: string,
  op: PatchOp
): typeof FAIL | null => {
  const index = last === "-" ? parent.length : Number(last);
  if (!Number.isInteger(index) || index < 0 || index > parent.length)
    return FAIL;
  if (op.op === "add") {
    parent.splice(index, 0, op.value);
    return null;
  }
  if (index >= parent.length) return FAIL;
  if (op.op === "replace") parent[index] = op.value;
  else parent.splice(index, 1);
  return null;
};

const applyObject = (
  parent: Record<string, unknown>,
  last: string,
  op: PatchOp
): typeof FAIL | null => {
  if (op.op === "add") {
    parent[last] = op.value;
    return null;
  }
  if (!Object.hasOwn(parent, last)) return FAIL;
  if (op.op === "replace") parent[last] = op.value;
  else delete parent[last];
  return null;
};

const applyOne = (doc: unknown, op: PatchOp): unknown => {
  if (op.op !== "add" && op.op !== "replace" && op.op !== "remove") return FAIL;
  const tokens = parsePointer(op.path);
  if (tokens == null) return FAIL;
  if (tokens.length === 0) return op.op === "remove" ? FAIL : op.value;
  if (!isContainer(doc)) return FAIL;
  const root = copyOf(doc);
  let parent: Container = root;
  for (const token of tokens.slice(0, -1)) {
    const child = read(parent, token);
    if (!isContainer(child)) return FAIL;
    const copy = copyOf(child);
    write(parent, token, copy);
    parent = copy;
  }
  const last = tokens.at(-1)!;
  const failed = Array.isArray(parent)
    ? applyArray(parent, last, op)
    : applyObject(parent, last, op);
  return failed ?? root;
};

export const applyPatch = <T>(doc: T, ops: readonly PatchOp[]): T | null => {
  let current: unknown = doc;
  for (const op of ops) {
    current = applyOne(current, op);
    if (current === FAIL) return null;
  }
  return current as T;
};
