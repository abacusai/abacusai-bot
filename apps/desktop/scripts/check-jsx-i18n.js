#!/usr/bin/env node

/** Inspect JSX syntax, including multiline text and one-word controls. */
import fs from "node:fs";
import path from "node:path";

import { parse } from "@babel/parser";

const root = path.resolve(import.meta.dirname, "..");
const uiAttributes = new Set([
  "placeholder",
  "title",
  "aria-label",
  "alt",
  "label",
  "message",
  "tooltip",
  "allowLabel",
  "alwaysAllowLabel",
]);
// Product names and addresses are deliberately unchanged in every language.
const literalNames = new Set(["Abacus", "AI Bot", "skills.sh"]);
const problems = [];
function walkDirectory(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walkDirectory(file);
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx"))
      scan(file);
  }
}
function scan(file) {
  const source = fs.readFileSync(file, "utf8");
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });
  function report(node, text) {
    const value = text.trim().replace(/\s+/g, " ");
    if (!/[A-Za-z]/.test(value) || literalNames.has(value)) return;
    problems.push(
      `${path.relative(root, file)}:${node.loc.start.line}: ${JSON.stringify(value)}`
    );
  }
  function visit(node, parent, grandparent) {
    if (!node || typeof node !== "object") return;
    if (node.type === "JSXText") report(node, node.value);
    if (
      node.type === "JSXAttribute" &&
      uiAttributes.has(node.name.name) &&
      node.value?.type === "StringLiteral"
    )
      report(node, node.value.value);
    if (
      node.type === "StringLiteral" &&
      parent?.type === "JSXExpressionContainer" &&
      (grandparent?.type !== "JSXAttribute" ||
        uiAttributes.has(grandparent.name.name))
    )
      report(node, node.value);
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        value.forEach((child) => visit(child, node, parent));
      else if (value?.type) visit(value, node, parent);
    }
  }
  visit(ast);
}
walkDirectory(path.join(root, "src/renderer"));
if (problems.length) {
  console.error(
    `[i18n-guard] ${problems.length} untranslated JSX literals:\n${problems.join("\n")}`
  );
  process.exitCode = 1;
} else
  console.log(
    "[i18n-guard] All JSX text and literal UI attributes are localized."
  );
