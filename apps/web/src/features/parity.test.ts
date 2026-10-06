import fs from "node:fs";
import path from "node:path";

import { parseSync } from "oxc-parser";
import { expect, it } from "vitest";

import { PHASE5_PARITY as artifacts } from "./artifacts/parity";
import { BOT_PARITY } from "./bots/parity";
import { PHASE5_PARITY as library } from "./library/parity";
import { PHASE6_NOTCH_PARITY } from "./notch/parity";
import { PHASE6_ONBOARDING_PARITY } from "./onboarding/parity";
import { PHASE5_PARITY as routines } from "./routines/parity";
import { SESSION_PARITY } from "./sessions/parity";
import { PHASE5_PARITY as settings } from "./settings/parity";
const desktop = path.resolve(import.meta.dirname, "../../../..");
const ids = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "parity-ids.json"), "utf8")
) as Record<string, string[]>;
const rows = [
  ...BOT_PARITY,
  ...SESSION_PARITY,
  ...routines,
  ...artifacts,
  ...library,
  ...settings,
  ...PHASE6_ONBOARDING_PARITY,
  ...PHASE6_NOTCH_PARITY,
];
const resolves = (consumer: string) => {
  if (consumer.startsWith("retired: "))
    return /[.!?]$/.test(consumer.slice(9).trim());
  const [file, symbol] = consumer.split("#");
  if (
    !file?.startsWith("apps/web/src/") &&
    !file?.startsWith("apps/desktop/src/main/")
  )
    return false;
  if (
    !symbol ||
    file.includes("..") ||
    !fs.existsSync(path.join(desktop, file))
  )
    return false;
  const result = parseSync(
    file,
    fs.readFileSync(path.join(desktop, file), "utf8")
  );
  if (result.errors.length) return false;
  let found = false;
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (
      [
        "VariableDeclarator",
        "FunctionDeclaration",
        "ClassDeclaration",
        "TSTypeAliasDeclaration",
        "TSInterfaceDeclaration",
      ].includes(String(node.type)) &&
      (node.id as { name?: string })?.name === symbol
    )
      found = true;
    if (
      node.type === "ExportSpecifier" &&
      (node.exported as { name?: string })?.name === symbol
    )
      found = true;
    for (const child of Object.values(node))
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === "object") walk(child);
  };
  walk(result.program);
  return found;
};
it("R7-T25 has the exact parity-id set without duplicate, missing or extra rows", () => {
  expect(rows.map((row) => row.id).toSorted()).toEqual(
    Object.values(ids).flat().toSorted()
  );
});
it("R7-T25 resolves every consumer declaration in the new tree or main", () => {
  for (const row of rows)
    expect(resolves(row.consumer), row.id + ": " + row.consumer).toBe(true);
  expect(resolves("src/app.tsx#App")).toBe(false);
  expect(resolves("apps/web/src/features/settings/companion.tsx#Missing")).toBe(
    false
  );
});

it("R7-T25 requires final status metadata and preserves acceptance gaps", () => {
  for (const row of rows) {
    const metadata = row as unknown as Record<string, unknown>;
    expect(["green", "retired", "deferred"]).toContain(row.status);
    expect(typeof metadata.visible).toBe("boolean");
    if (row.status === "green") expect(metadata.evidence).toBeTruthy();
    else expect(metadata.reason).toBeTruthy();
    if (row.status === "deferred") {
      expect(metadata.owner).toBeTruthy();
      expect(metadata.plan).toBe("docs/rewrite/PLAN.md#phases-and-pr-stack");
    }
  }
});
