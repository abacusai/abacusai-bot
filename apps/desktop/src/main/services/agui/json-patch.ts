/**
 * The RFC 6902 subset `STATE_DELTA` uses (agent spec §3.3.2: `replace /mode`,
 * `replace /modeSource`, `replace /model`, `add /plan`): `add`, `replace` and
 * `remove` on object members, plus array append with `-`. Pure; returns null
 * for anything else, so the caller drops its copy of the state rather than
 * holding a wrong one.
 */
export type JsonPatchOp = {
  op: string;
  path: string;
  value?: unknown;
};

const unescape = (token: string): string =>
  token.replace(/~1/g, "/").replace(/~0/g, "~");

const clone = <T>(value: T): T =>
  value == null || typeof value !== "object"
    ? value
    : (JSON.parse(JSON.stringify(value)) as T);

export const applyJsonPatch = <T>(
  document: T,
  ops: readonly JsonPatchOp[]
): T | null => {
  let root: unknown = clone(document);

  for (const operation of ops) {
    if (
      operation == null ||
      typeof operation.path !== "string" ||
      (operation.op !== "add" &&
        operation.op !== "replace" &&
        operation.op !== "remove")
    )
      return null;
    if (operation.path === "") {
      if (operation.op === "remove") return null;
      root = clone(operation.value);
      continue;
    }
    if (!operation.path.startsWith("/")) return null;
    const tokens = operation.path.slice(1).split("/").map(unescape);
    const last = tokens.pop()!;
    let parent: unknown = root;
    for (const token of tokens) {
      if (parent == null || typeof parent !== "object") return null;
      parent = (parent as Record<string, unknown>)[token];
    }
    if (parent == null || typeof parent !== "object") return null;

    if (Array.isArray(parent)) {
      const index = last === "-" ? parent.length : Number(last);
      if (!Number.isInteger(index) || index < 0 || index > parent.length)
        return null;
      if (operation.op === "add")
        parent.splice(index, 0, clone(operation.value));
      else if (index >= parent.length) return null;
      else if (operation.op === "replace")
        parent[index] = clone(operation.value);
      else parent.splice(index, 1);
      continue;
    }

    const record = parent as Record<string, unknown>;
    if (operation.op === "add") record[last] = clone(operation.value);
    else if (!(last in record)) return null;
    else if (operation.op === "replace") record[last] = clone(operation.value);
    else delete record[last];
  }

  return root as T;
};
