import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createInstance } from "i18next";
import { parseSync } from "oxc-parser";

import { sourceFiles } from "./i18n-consumers.mjs";

const filler =
  /^(?:(?:connectors|messaging|skills|tools|disconnect|uninstall skill|unlink) description|connect name|connect waiting|credentials local|disconnect title|unlink title|remote warning|powered skills)$|fills in with a later update|arrive soon|has not exposed .* yet|customize .* preferences here/i;
export function validateCopy(resource, keys, retainedKeys = []) {
  const i18n = createInstance();
  i18n.init({
    lng: "en",
    fallbackLng: false,
    resources: { en: { translation: resource } },
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  const problems = [];
  for (const key of keys) {
    const value = i18n.t(key, { returnObjects: true, count: 2 });
    if (!i18n.exists(key, { count: 2 })) problems.push(`Missing key: ${key}`);
    else if (typeof value !== "string" || !value.trim())
      problems.push(`Non-string key: ${key}`);
  }
  const visit = (node, prefix = "") => {
    for (const [key, value] of Object.entries(node)) {
      const name = prefix + key;
      if (typeof value === "object" && value !== null) visit(value, name + ".");
      // Main's retired onboarding copy includes an empty string sentinel. Retaining
      // it is compatible with the locale union, but using it as UI copy still
      // fails the consumer check above.
      else if ((value === false || value === "") && retainedKeys.includes(name))
        continue;
      else if (typeof value !== "string" || !value.trim())
        problems.push(`Non-string leaf: ${name}`);
      else if (filler.test(value)) problems.push(`Placeholder copy: ${name}`);
    }
  };
  visit(resource);
  return problems;
}

const walk = (node, visit) => {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
};
export const literalTranslationKeys = (sources, resource = {}) => {
  const keys = new Set();
  const argument = (node) => {
    if (node?.type === "Literal" && typeof node.value === "string")
      keys.add(node.value);
    else if (node?.type === "ConditionalExpression") {
      argument(node.consequent);
      argument(node.alternate);
    } else if (
      node?.type === "TemplateLiteral" &&
      node.expressions.length === 0
    )
      keys.add(node.quasis[0].value.cooked);
    else if (
      node?.type === "TemplateLiteral" &&
      node.expressions.length === 1 &&
      node.quasis[0].value.cooked === "capabilities.toolsets."
    ) {
      // This finite catalog maps IDs to objects. Every consumer must choose a leaf.
      const suffix = node.quasis[1].value.cooked;
      for (const id of Object.keys(resource.capabilities?.toolsets ?? {}))
        keys.add(`capabilities.toolsets.${id}${suffix}`);
    }
  };
  for (const [file, source] of Object.entries(sources))
    walk(parseSync(file, source).program, (node) => {
      if (
        node.type === "CallExpression" &&
        (node.callee?.name === "t" || node.callee?.property?.name === "t")
      )
        argument(node.arguments[0]);
    });
  return keys;
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(import.meta.dirname, "../src/renderer");
  const english = JSON.parse(
    fs.readFileSync(path.join(root, "locales/en-US.json"))
  );
  const keys = literalTranslationKeys(sourceFiles(root), english);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "i18n-dynamic-keys.json"))
  );
  for (const row of manifest)
    for (const value of row.values) keys.add(row.prefix + value);
  const failures = [];
  const retained = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "i18n-retained-keys.json"))
  ).keys;
  for (const file of fs
    .readdirSync(path.join(root, "locales"))
    .filter((file) => file.endsWith(".json"))) {
    const resource = JSON.parse(
      fs.readFileSync(path.join(root, "locales", file))
    );
    failures.push(
      ...validateCopy(resource, keys, retained).map(
        (problem) => `${file}: ${problem}`
      )
    );
  }
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      `UI copy: ${keys.size} keys resolve to strings in all 11 locales; no placeholder copy.`
    );
}
