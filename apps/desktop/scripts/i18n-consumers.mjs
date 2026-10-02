import fs from "node:fs";
import path from "node:path";

import { parseSync } from "oxc-parser";
export const flatten = (tree, prefix = "") =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string"
      ? [prefix + key]
      : flatten(value, prefix + key + ".")
  );
const plurals = ["_one", "_other", "_zero", "_two", "_few", "_many"];
const walk = (node, fn) => {
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const value of Object.values(node))
    if (Array.isArray(value)) value.forEach((n) => walk(n, fn));
    else if (value && typeof value === "object") walk(value, fn);
};
export const consumers = (
  keys,
  sources,
  dynamic = [],
  referenceKeys = keys
) => {
  const used = new Set(),
    literals = new Set(),
    templates = new Set();
  for (const [file, source] of Object.entries(sources))
    walk(parseSync(file, source).program, (node) => {
      if (node.type === "Literal" && typeof node.value === "string")
        literals.add(node.value);
      // Keys may be built in catalogues before they reach t(), including labelKey.
      if (node.type === "TemplateLiteral") {
        const prefix = node.quasis[0].value.cooked;
        if (prefix && keys.some((key) => key.startsWith(prefix)))
          templates.add(prefix);
      }
      if (
        node.type === "CallExpression" &&
        (node.callee?.name === "t" || node.callee?.property?.name === "t") &&
        node.arguments[0]?.type === "TemplateLiteral" &&
        !node.arguments[0].quasis[0].value.cooked &&
        !dynamic.some((row) => row.prefix === "")
      )
        throw new Error(`Unbounded translation template in ${file}`);
    });
  for (const key of keys)
    if (
      literals.has(key) ||
      plurals.some(
        (s) => key.endsWith(s) && literals.has(key.slice(0, -s.length))
      )
    )
      used.add(key);
  const known = new Set(keys);
  const families = new Map();
  for (const key of referenceKeys) {
    const suffix = plurals.find((suffix) => key.endsWith(suffix));
    if (!suffix) continue;
    const stem = key.slice(0, -suffix.length);
    const members = families.get(stem) ?? new Set();
    members.add(key);
    families.set(stem, members);
  }
  const requireKey = (key) => {
    if (!known.has(key)) throw new Error(`Missing translation key: ${key}`);
    used.add(key);
  };
  const requireFamily = (stem) => {
    const members = families.get(stem);
    if (!members) return false;
    for (const member of new Set([...members, stem + "_other"]))
      requireKey(member);
    return true;
  };
  for (const row of dynamic)
    for (const value of row.values) {
      const key = row.prefix + value;
      const suffix = plurals.find((suffix) => key.endsWith(suffix));
      const stem = suffix ? key.slice(0, -suffix.length) : key;
      if (!requireFamily(stem)) requireKey(key);
    }
  for (const literal of literals) requireFamily(literal);
  for (const prefix of templates)
    if (!dynamic.some((row) => row.prefix === prefix))
      for (const key of keys) if (key.startsWith(prefix)) used.add(key);
  return used;
};
export const sourceFiles = (dir) => {
  const sources = {};
  const visit = (directory) => {
    for (const e of fs.readdirSync(directory, { withFileTypes: true })) {
      if (e.name === "locales" || e.name === "ui") continue;
      const file = path.join(directory, e.name);
      if (e.isDirectory()) visit(file);
      else if (
        /\.tsx?$/.test(file) &&
        !/(?:\.test\.|\.d\.ts$|dynamic-keys\.ts$)/.test(file)
      )
        sources[file] = fs.readFileSync(file, "utf8");
    }
  };
  visit(dir);
  return sources;
};
