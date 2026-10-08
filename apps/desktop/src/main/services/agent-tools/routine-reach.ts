/**
 * What a routine's unattended runs may reach, in the two forms it travels
 * in: the app's (URL prefixes, and the account data it reads by name) and
 * the agent's policy (prefixes, and connector actions by gateway tool).
 */
import {
  sourcePrefix,
  UNATTENDED_CONNECTOR_READS,
  type UnattendedPolicy,
} from "@abacus-ai/agent/tool-policy";
import type { RoutineReach, RoutineRead } from "@abacus-ai/contract/routines";

/**
 * Each connector read, as the gateway tool and the reviewed read actions it
 * grants. Searching mail finds messages; reading them adds their bodies.
 */
const READ_ACTIONS: Readonly<
  Record<RoutineRead, { tool: string; actions: string[] }>
> = {
  "gmail.search": { tool: "Gmail_Tool", actions: ["search_email"] },
  "gmail.read": {
    tool: "Gmail_Tool",
    actions: ["search_email_verbose", "get_my_info"],
  },
  "calendar.read": {
    tool: "Google_Calendar_Tool",
    actions: [...(UNATTENDED_CONNECTOR_READS.Google_Calendar_Tool ?? [])],
  },
};

const READS = Object.keys(READ_ACTIONS) as RoutineRead[];

export const isRoutineRead = (value: unknown): value is RoutineRead =>
  typeof value === "string" && READS.includes(value as RoutineRead);

/** The connector actions a set of reads grants: reviewed reads only. */
export const connectorReadsFor = (
  reads: readonly RoutineRead[]
): Record<string, string[]> => {
  const granted: Record<string, string[]> = {};
  for (const read of new Set(reads)) {
    const { tool, actions } = READ_ACTIONS[read];
    const allowed = UNATTENDED_CONNECTOR_READS[tool] ?? [];
    granted[tool] = [
      ...new Set([
        ...(granted[tool] ?? []),
        ...actions.filter((action) => allowed.includes(action)),
      ]),
    ];
  }
  return granted;
};

/** The reads a server's `connector_reads` names; anything else is dropped. */
export const readsFromConnectorReads = (value: unknown): RoutineRead[] =>
  Array.isArray(value) ? [...new Set(value.filter(isRoutineRead))] : [];

/**
 * Declared sources as prefixes, and what was refused: anything that is not
 * an http(s) URL or host, or that sits on a host anyone can publish on.
 */
export const cleanSources = (
  raw: readonly string[]
): { sources: string[]; refused: string[] } => {
  const sources: string[] = [];
  const refused: string[] = [];
  for (const entry of raw) {
    const prefix = sourcePrefix(entry);
    if (prefix == null || isLocalOrLiteral(prefix.hostname))
      refused.push(entry);
    else if (!sources.includes(prefix.href)) sources.push(prefix.href);
  }
  // A routine reads a few sites, not the web.
  return {
    sources: sources.slice(0, MAX_SOURCES),
    refused: [...refused, ...sources.slice(MAX_SOURCES)],
  };
};

/** The most sources one routine may declare. */
export const MAX_SOURCES = 10;

/** localhost, a single-label name, or an IP literal: never a source. */
const isLocalOrLiteral = (host: string): boolean => {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    bare === "localhost" ||
    bare.endsWith(".localhost") ||
    !bare.includes(".") ||
    /^[\d.]+$/.test(bare) ||
    bare.includes(":")
  );
};

/** An unattended run's policy from a routine's confirmed reach. */
export const policyFor = (
  reach: RoutineReach | null | undefined,
  extra: {
    watchUrl?: string | null;
    watchPrompt?: string;
    privateInput?: boolean;
    /** False: the run reads no files (a hosted run's folder holds other runs). */
    files?: boolean;
  } = {}
): UnattendedPolicy => ({
  sources: cleanSources(reach?.sources ?? []).sources,
  watchUrl: extra.watchUrl ?? null,
  ...(extra.watchPrompt != null ? { watchPrompt: extra.watchPrompt } : {}),
  connectorReads: connectorReadsFor(reach?.reads ?? []),
  ...(extra.privateInput === true ? { privateInput: true } : {}),
  ...(extra.files === false ? { files: false } : {}),
});
