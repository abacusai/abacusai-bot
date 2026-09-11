/**
 * The file a user attaches to a bug report.
 *
 * Every case here is a report that could not be answered from the old dump:
 * a session that died before anyone could press the menu item, a spawn whose
 * interpreter was never named, an MCP server that never connected, usage that
 * looks wrong, and a machine whose OS build and PATH were nowhere in the file.
 * The last one is the opposite worry — that collecting more of the machine
 * starts shipping the user's secrets.
 */
import os from "node:os";

import { describe, expect, it } from "vitest";

import type { AgentSessionSnapshot, UsageSnapshot } from "#shared/contracts";

import {
  buildLogDump,
  collectEnvironmentInfo,
  tailStderr,
  type AgentSessionDiagnostics,
} from "./log-dump";
import { scrub } from "./scrub";

const state = (
  overrides: Partial<AgentSessionSnapshot> = {}
): AgentSessionSnapshot =>
  ({
    workspaceId: "w1",
    sessionId: "s1",
    status: "stopped",
    agentStatus: "idle",
    pid: null,
    model: "openllm/auto",
    mode: "DEFAULT",
    startedAt: "2026-01-01T00:00:00.000Z",
    stoppedAt: "2026-01-01T00:00:01.000Z",
    exitCode: 1,
    error: null,
    ...overrides,
  }) as AgentSessionSnapshot;

const session = (
  overrides: Partial<AgentSessionDiagnostics> = {}
): AgentSessionDiagnostics => ({
  sessionId: "s1",
  workspaceId: "w1",
  label: "repo",
  state: state(),
  agentSessionId: null,
  agentSessionFile: null,
  stderrTail: "",
  mcpServers: [],
  mcpLogs: [],
  command: "/Applications/App.app/Contents/MacOS/App /res/agent/main.js",
  live: true,
  ...overrides,
});

const environment = () =>
  collectEnvironmentInfo({
    resourcesPath: "/res",
    agentEntry: "/res/agent/main.js",
  });

const dump = (overrides: Partial<Parameters<typeof buildLogDump>[0]> = {}) =>
  buildLogDump({
    appVersion: "1.2.3",
    isPackaged: true,
    homeDir: "/Users/ada/.abacusai-bot",
    rendererLogs: "",
    sessions: [],
    environment: environment(),
    usage: null,
    ...overrides,
  });

describe("the dump's account section", () => {
  it("names the plan and what is left of the credits", () => {
    // Every out-of-credits report has cost a round trip asking which tier the
    // user is on; the usage table says what was billed, not what is allowed.
    const text = dump({
      account: {
        user_id: "u1",
        organization_id: null,
        name: null,
        email: null,
        picture: null,
        organization: null,
        org_user_count: null,
        plan: "Basic",
        subscription_tier: "basic",
        credits_used: 2000,
        credits_granted: 2000,
      },
    });

    expect(text).toContain("plan: Basic  tier: basic");
    expect(text).toContain("credits: 2000 used of 2000 granted");
  });

  it("says so plainly when there is no account to read", () => {
    expect(dump({ account: null })).toContain("not signed in");
  });
});

describe("the dump's session section", () => {
  it("keeps a session whose process has already gone", () => {
    const text = dump({
      sessions: [
        session({
          live: false,
          stderrTail: "ERR_MODULE_NOT_FOUND: cannot find 'sharp'",
        }),
      ],
    });

    // The whole point: the evidence outlives the process that produced it.
    expect(text).toContain("[exited]");
    expect(text).toContain("ERR_MODULE_NOT_FOUND");
  });

  it("names what was actually executed, interpreter included", () => {
    expect(dump({ sessions: [session()] })).toContain(
      "command: /Applications/App.app/Contents/MacOS/App /res/agent/main.js"
    );
  });

  it("carries each MCP server's own log, not just its status row", () => {
    const text = dump({
      sessions: [
        session({
          mcpLogs: [
            {
              serverId: "gh",
              entries: [
                {
                  serverId: "gh",
                  source: "stderr",
                  level: "error",
                  line: "spawn npx ENOENT",
                  ts: "2026-01-01T00:00:00.000Z",
                },
              ],
            },
          ],
        }),
      ],
    });

    expect(text).toContain("mcp log gh:");
    expect(text).toContain("spawn npx ENOENT");
  });

  it("says so plainly when there were no sessions at all", () => {
    expect(dump()).toContain("(no agent sessions this run)");
  });
});

describe("the dump's environment section", () => {
  it("carries the OS build, the shell and the PATH a spawn ran with", () => {
    const text = dump();

    expect(text).toContain("=== ENVIRONMENT ===");
    expect(text).toContain(os.release());
    expect(text).toMatch(/(SHELL|COMSPEC)=/);
    expect(text).toContain("PATH: ");
  });

  it("marks a bundled path that never arrived", () => {
    const info = collectEnvironmentInfo({
      resourcesPath: "/res",
      agentEntry: "/nowhere/agent/main.js",
    });

    expect(info.agentEntryExists).toBe(false);
    expect(
      buildLogDump({
        appVersion: "1.2.3",
        isPackaged: true,
        homeDir: "/tmp/home",
        rendererLogs: "",
        sessions: [],
        environment: info,
        usage: null,
      })
    ).toContain("(MISSING)");
  });

  it("counts what a directory that did arrive holds", () => {
    const info = collectEnvironmentInfo({
      resourcesPath: os.tmpdir(),
      agentEntry: `${os.tmpdir()}/agent/main.js`,
    });

    expect(
      info.bundledPaths.every((entry) => typeof entry.path === "string")
    ).toBe(true);
  });

  it("reports why the agent could not be resolved", () => {
    const text = dump({
      environment: collectEnvironmentInfo({
        resourcesPath: "/res",
        agentEntry: "/res/agent/main.js",
        artifactError: 'agent entry not found. Run "pnpm build" first.',
      }),
    });

    expect(text).toContain("artifact resolver: agent entry not found");
  });
});

describe("the dump's usage section", () => {
  const usage: UsageSnapshot = {
    generatedAt: 0,
    days: 30,
    totals: {
      requests: 7,
      errors: 6,
      input: 5000,
      output: 2900,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    },
    today: {
      requests: 7,
      errors: 6,
      input: 5000,
      output: 2900,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    },
    models: [
      {
        id: "openrouter/auto",
        provider: "openrouter",
        modelId: "auto",
        pool: false,
        billing: "unknown",
        requests: 7,
        errors: 6,
        input: 5000,
        output: 2900,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        today: {
          requests: 7,
          errors: 6,
          input: 5000,
          output: 2900,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
        },
        lastUsed: 0,
      },
    ],
    daily: [],
    unpriced: true,
    openrouter: null,
  };

  it("shows the row a pricing report is about, priced or not", () => {
    const text = dump({ usage });

    expect(text).toContain("openrouter/auto");
    expect(text).toContain("billing=unknown");
    expect(text).toContain("unknown price");
  });

  it("loses the section, not the file, when the scan fails", () => {
    const text = dump({ usage: null, usageError: "EACCES: sessions/" });

    expect(text).toContain("(usage unavailable: EACCES: sessions/)");
    expect(text).toContain("=== MAIN PROCESS LOGS ===");
  });
});

describe("scrubbing", () => {
  it("redacts the key shapes that reach a console line", () => {
    const text = scrub(
      [
        "OPENAI_API_KEY=sk-abcd1234efgh5678",
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload",
        'header {"api_key": "or-v1-9f8e7d6c5b4a"}',
        "ghp_0123456789abcdefghijABCDEF",
      ].join("\n")
    );

    expect(text).not.toContain("sk-abcd1234efgh5678");
    expect(text).not.toContain("eyJhbGciOiJIUzI1NiJ9.payload");
    expect(text).not.toContain("or-v1-9f8e7d6c5b4a");
    expect(text).not.toContain("ghp_0123456789abcdefghijABCDEF");
  });

  it("takes the user's name out of every path", () => {
    const text = scrub(
      "/Users/adalovelace/work/repo and /Users/adalovelace/.abacusai-bot",
      "/Users/adalovelace/.abacusai-bot"
    );

    expect(text).not.toContain("adalovelace");
    expect(text).toContain("/Users/<user>/work/repo");
  });

  it("leaves ordinary text alone", () => {
    expect(scrub("spawn npx ENOENT")).toBe("spawn npx ENOENT");
  });

  it("runs over the finished dump, so new sections are covered by default", () => {
    const text = dump({
      sessions: [session({ stderrTail: "auth failed for sk-livekey12345678" })],
    });

    expect(text).not.toContain("sk-livekey12345678");
  });
});

describe("stderr tails", () => {
  it("keeps the end, which is where a child says why it died", () => {
    const tail = tailStderr(`${"x".repeat(30_000)}the last words`);

    expect(tail.endsWith("the last words")).toBe(true);
    expect(tail.length).toBeLessThan(30_000);
  });
});
