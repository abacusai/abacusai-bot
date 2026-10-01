import fs from "node:fs";

import { parseSync } from "oxc-parser";
export const walk = (node, visit) => {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) for (const item of value) walk(item, visit);
    else if (value && typeof value === "object") walk(value, visit);
  }
};
export const parseSource = (file, source = fs.readFileSync(file, "utf8")) => {
  const result = parseSync(file, source);
  if (result.errors.length)
    throw new Error(`Cannot parse ${file}: ${JSON.stringify(result.errors)}`);
  return result;
};
export const declaredSymbols = (file) => {
  const symbols = new Set();
  walk(parseSource(file).program, (node) => {
    if (
      [
        "VariableDeclarator",
        "FunctionDeclaration",
        "ClassDeclaration",
        "TSTypeAliasDeclaration",
        "TSInterfaceDeclaration",
      ].includes(node.type) &&
      node.id?.name
    )
      symbols.add(node.id.name);
    if (node.type === "ExportSpecifier")
      symbols.add(node.exported.name ?? node.exported.value);
  });
  return symbols;
};
export const specifiers = (file, source) => {
  const result = new Set();
  walk(parseSource(file, source).program, (node) => {
    if (
      [
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
        "ImportExpression",
      ].includes(node.type) &&
      typeof node.source?.value === "string"
    )
      result.add(node.source.value);
    if (node.type === "TSImportType" && typeof node.source?.value === "string")
      result.add(node.source.value);
    if (
      node.type === "TSExternalModuleReference" &&
      typeof node.expression?.value === "string"
    )
      result.add(node.expression.value);
    if (
      node.type === "CallExpression" &&
      node.callee?.name === "require" &&
      typeof node.arguments[0]?.value === "string"
    )
      result.add(node.arguments[0].value);
  });
  return [...result];
};
