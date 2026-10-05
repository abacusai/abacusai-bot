/**
 * A-T6: the contract is the parity list. Every legacy `window.api.agent.*`
 * method, every top-level `window.api.*` member, every `IpcEvent` variant and
 * every other push channel the preload listens on has a row in
 * shared/contract/legacy-map.ts: a procedure the contract really has, or a
 * retirement with a reason. A new legacy method without a row fails here.
 *
 * `UPDATE_PARITY=1` also writes docs/rewrite/PARITY.md from the same tables.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const exposed = new Map<string, unknown>();

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) =>
      exposed.set(name, value),
  },
  ipcRenderer: {
    sendSync: () => ({}),
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    postMessage: vi.fn(),
    getMaxListeners: () => 64,
    setMaxListeners: vi.fn(),
  },
  webUtils: { getPathForFile: () => "" },
}));

import { contract } from "#shared/contract";
import {
  LEGACY_BRIDGE_MAP,
  LEGACY_CHANNEL_MAP,
  LEGACY_EVENT_MAP,
  LEGACY_TOP_LEVEL_MAP,
  type LegacyDestination,
} from "#shared/contract/legacy-map";

import { createBridge } from "./bridge";

const DESKTOP = join(import.meta.dirname, "../..");
const REPO = join(DESKTOP, "../..");
const read = (path: string): string =>
  readFileSync(join(DESKTOP, path), "utf8");

// --- what the legacy surface actually is ------------------------------------

const bridgeKeys = (): string[] =>
  // In definition order, as PARITY.md lists them.
  Object.keys(createBridge({ invoke: vi.fn(), send: vi.fn() } as never));

const topLevelKeys = async (): Promise<string[]> => {
  vi.stubGlobal("window", { addEventListener: vi.fn(), postMessage: vi.fn() });
  Object.defineProperty(process, "contextIsolated", {
    value: true,
    configurable: true,
  });
  await import("./index");
  vi.unstubAllGlobals();

  const api = exposed.get("api") as Record<string, unknown>;
  return Object.entries(api)
    .filter(([name]) => name !== "agent")
    .flatMap(([name, value]) =>
      // Namespaces (power, update, skills, files, durableState) by member;
      // `versions` is a value, not a namespace.
      value != null &&
      typeof value === "object" &&
      name !== "versions" &&
      !Array.isArray(value)
        ? Object.keys(value).map((member) => `${name}.${member}`)
        : [name]
    );
};

/** Every `type` in the `IpcEvent` union, read from its declaration. */
const ipcEventTypes = (): string[] => {
  const source = read("src/shared/contracts.ts");
  const start = source.indexOf("export type IpcEvent =");
  const end = source.indexOf("\nexport ", start + 1);
  return [
    ...new Set(
      [...source.slice(start, end).matchAll(/\btype: "([^"]+)"/g)].map(
        (match) => match[1]!
      )
    ),
  ].sort();
};

/** Channels the preload subscribes to other than the `IpcEvent` catch-all. */
const pushChannels = (): string[] => {
  const sources = [read("src/preload/index.ts"), read("src/preload/bridge.ts")];
  return [
    ...new Set(
      sources.flatMap((source) =>
        [...source.matchAll(/ipcRenderer\.on\(\s*"([^"]+)"/g)].map(
          (match) => match[1]!
        )
      )
    ),
  ].sort();
};

// --- what the contract has ---------------------------------------------------

type ProcedureInfo = { path: string; kind: string };

const contractProcedures = (): ProcedureInfo[] => {
  const out: ProcedureInfo[] = [];
  const visit = (node: unknown, path: string[]): void => {
    if (node == null || typeof node !== "object") return;
    const def = (node as { "~orpc"?: { meta?: { kind?: string } } })["~orpc"];
    if (def != null) {
      out.push({ path: path.join("."), kind: def.meta?.kind ?? "?" });
      return;
    }
    for (const [key, child] of Object.entries(node))
      visit(child, [...path, key]);
  };
  visit(contract, []);
  return out.sort((a, b) => a.path.localeCompare(b.path));
};

const PROCEDURE_PATHS = new Set(contractProcedures().map((p) => p.path));

/** A row that names a procedure must name one the contract has. */
const problemsWith = (key: string, row: LegacyDestination): string[] => {
  if (row.kind === "R")
    return row.reason.trim().length > 0
      ? []
      : [`${key}: retired with no reason`];
  // "(split)" and "(preload) …" are not procedures, by design.
  if (row.procedure.startsWith("(")) return [];
  return PROCEDURE_PATHS.has(row.procedure)
    ? []
    : [`${key}: names ${row.procedure}, which the contract does not have`];
};

// --- PARITY.md ---------------------------------------------------------------

/** `file:line` of a member's definition, so a reviewer can find it. */
const locate = (file: string, key: string): string => {
  const source = read(file);
  const lines = source.split("\n");
  const parts = key.split(".");
  let from = 0;
  for (const part of parts) {
    const pattern = new RegExp(`^\\s*${part}\\s*[:(]`);
    const index = lines.findIndex((line, i) => i >= from && pattern.test(line));
    if (index === -1) return file.replace("src/", "");
    from = index;
  }
  return `${file.replace("src/", "")}:${from + 1}`;
};

const cell = (text: string | undefined): string =>
  (text ?? "").replaceAll("|", "\\|");

const destinationCells = (row: LegacyDestination): string =>
  row.kind === "R"
    ? `— | R | ${cell(row.reason)}`
    : `\`${row.procedure}\` | ${row.kind} | ${cell(row.note)}`;

const renderParity = (bridge: string[], topLevel: string[]): string => {
  const count = (rows: LegacyDestination[], kind: string): number =>
    rows.filter((row) => row.kind === kind).length;
  const bridgeRows = bridge.map(
    (key) => LEGACY_BRIDGE_MAP[key as never] as LegacyDestination
  );
  const topRows = topLevel.map((key) => LEGACY_TOP_LEVEL_MAP[key]!);
  const summary = (rows: LegacyDestination[]): string =>
    ["Q", "M", "S", "T", "R"]
      .map((kind) => `${count(rows, kind)} ${kind}`)
      .join(", ");

  const lines: string[] = [
    "# Parity: legacy IPC → oRPC contract",
    "",
    "Generated by `apps/desktop/src/preload/parity.test.ts` (A-T6) from",
    "`apps/desktop/src/shared/contract/legacy-map.ts`. Do not edit by hand:",
    "change the map, then run it with `UPDATE_PARITY=1`.",
    "",
    "Kinds: **Q** query, **M** mutation, **S** event-iterator subscription,",
    "**T** served by a DB table (sub-slice B), **R** retired (its legacy",
    "handler stays until the cut-over).",
    "",
    `## \`window.api.agent.*\` (${bridge.length}: ${summary(bridgeRows)})`,
    "",
    "| # | Legacy | Defined at | Procedure | Kind | Notes |",
    "|---|---|---|---|---|---|",
    ...bridge.map(
      (key, index) =>
        `| ${index + 1} | \`${key}\` | ${locate("src/preload/bridge.ts", key)} | ${destinationCells(bridgeRows[index]!)} |`
    ),
    "",
    `## Top-level \`window.api.*\` (${topLevel.length}: ${summary(topRows)})`,
    "",
    "| # | Legacy | Defined at | Procedure | Kind | Notes |",
    "|---|---|---|---|---|---|",
    ...topLevel.map(
      (key, index) =>
        `| ${index + 1} | \`${key}\` | ${locate("src/preload/index.ts", key)} | ${destinationCells(topRows[index]!)} |`
    ),
    "",
    `## \`IpcEvent\` variants (${Object.keys(LEGACY_EVENT_MAP).length})`,
    "",
    "| `IpcEvent.type` | New home | Notes |",
    "|---|---|---|",
    ...ipcEventTypes().map((type) => {
      const row = LEGACY_EVENT_MAP[type as keyof typeof LEGACY_EVENT_MAP];
      return `| \`${type}\` | ${cell(row.destination)} | ${cell(row.note)} |`;
    }),
    "",
    "## Other push channels",
    "",
    "| Channel | New home | Notes |",
    "|---|---|---|",
    ...Object.entries(LEGACY_CHANNEL_MAP).map(
      ([channel, row]) =>
        `| \`${channel}\` | ${cell(row.destination)} | ${cell(row.note)} |`
    ),
    "",
    `## Contract procedures (${PROCEDURE_PATHS.size})`,
    "",
    "Every procedure, with the legacy members it replaces (none: new in the contract).",
    "",
    "| Procedure | Kind | Replaces |",
    "|---|---|---|",
    ...contractProcedures().map(({ path, kind }) => {
      const replaces = [
        ...bridge
          .filter(
            (key) =>
              (LEGACY_BRIDGE_MAP[key as never] as LegacyDestination).kind !==
                "R" &&
              (LEGACY_BRIDGE_MAP[key as never] as { procedure?: string })
                .procedure === path
          )
          .map((key) => `agent.${key}`),
        ...topLevel.filter(
          (key) =>
            (LEGACY_TOP_LEVEL_MAP[key] as { procedure?: string }).procedure ===
            path
        ),
      ];
      return `| \`${path}\` | ${kind} | ${replaces.map((key) => `\`${key}\``).join(", ")} |`;
    }),
    "",
  ];
  return lines.join("\n");
};

describe("parity with the legacy bridge (A-T6)", () => {
  it("has a row for every window.api.agent method, and none stale", () => {
    const keys = bridgeKeys();
    expect(keys.length).toBeGreaterThan(190);
    expect(keys.filter((key) => !(key in LEGACY_BRIDGE_MAP))).toEqual([]);
    expect(
      Object.keys(LEGACY_BRIDGE_MAP).filter((key) => !keys.includes(key))
    ).toEqual([]);
  });

  it("has a row for every top-level window.api member, and none stale", async () => {
    const keys = await topLevelKeys();
    expect(keys.length).toBeGreaterThan(45);
    expect(keys.filter((key) => !(key in LEGACY_TOP_LEVEL_MAP))).toEqual([]);
    expect(
      Object.keys(LEGACY_TOP_LEVEL_MAP).filter((key) => !keys.includes(key))
    ).toEqual([]);
  });

  it("names only procedures the contract has, and a reason for every retirement", () => {
    const problems = [
      ...Object.entries(LEGACY_BRIDGE_MAP).flatMap(([key, row]) =>
        problemsWith(`agent.${key}`, row)
      ),
      ...Object.entries(LEGACY_TOP_LEVEL_MAP).flatMap(([key, row]) =>
        problemsWith(key, row)
      ),
    ];
    expect(problems).toEqual([]);
  });

  it("has a home for every IpcEvent variant and every other push channel", () => {
    const types = ipcEventTypes();
    expect(types.length).toBeGreaterThan(40);
    expect(types.filter((type) => !(type in LEGACY_EVENT_MAP))).toEqual([]);
    expect(
      Object.keys(LEGACY_EVENT_MAP).filter((type) => !types.includes(type))
    ).toEqual([]);

    expect(
      pushChannels().filter((channel) => !(channel in LEGACY_CHANNEL_MAP))
    ).toEqual([]);
  });

  it("renders PARITY.md (written with UPDATE_PARITY=1)", async () => {
    const markdown = renderParity(bridgeKeys(), await topLevelKeys());
    expect(markdown).toContain("| `getMetadata` |");
    expect(markdown).not.toContain("undefined");

    if (process.env.UPDATE_PARITY === "1")
      writeFileSync(join(REPO, "docs/rewrite/PARITY.md"), markdown);
  });
});
