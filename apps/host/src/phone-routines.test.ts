/**
 * Reminders and routines from AbacusAI Bot's WhatsApp number, end to end on
 * the hosted computer: refused on the free plan; the moment a payment lands
 * (the `upgraded` step event) the very next create goes to the server, and a
 * fire the server times runs and comes back for delivery to the chat.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WHATSAPP_CHANNEL } from "@abacus-ai/agent/channel";
import { abacusPlanTier } from "@abacus-ai/contract/models";
import type { Routine, RoutineCreateInput } from "@abacus-ai/contract/routines";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HostedRoutines,
  toRoutineListItem,
} from "#main/services/agent-tools/hosted-routines";
import type { HostedRunRequest } from "#main/services/agent-tools/hosted-run";
import { McpAgentToolsServer } from "#main/services/mcp/mcp-agent-tools-server";
import {
  accountMovedPlan,
  cachedAbacusAccount,
  clearAbacusCache,
  fetchAbacusAccount,
} from "#main/services/providers/abacus";
import { StepEvents } from "#main/services/session/step-events";

import { RoutineEntryRunner } from "./routine-runner";

vi.mock("#main/services/config/settings", async (original) => {
  const actual =
    await original<typeof import("#main/services/config/settings")>();
  return {
    ...actual,
    credentialFor: (name: string) =>
      name === "ABACUS_API_KEY" ? "key" : actual.credentialFor(name),
  };
});

const PHONE = "phone-session";
/** What the platform's /account says: the tier the test sets. */
let accountTier = "free";
let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "phone-routines-"));
  process.env.ABACUSAI_BOT_HOME = home;
  accountTier = "free";
  clearAbacusCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).endsWith("/account")
        ? new Response(
            JSON.stringify({
              user_id: "u1",
              organization_id: "o1",
              subscription_tier: accountTier,
              credits_used: 100,
              credits_granted: 2000,
            }),
            { status: 200 }
          )
        : new Response("{}", { status: 404 })
    )
  );
  await fetchAbacusAccount(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const ROW = toRoutineListItem({
  id: "r1",
  kind: "task",
  name: "Daily brief",
  prompt: "My calendar and top emails",
  schedule: { cron: "0 8 * * *", timezone: "Asia/Kolkata" },
  enabled: true,
});

/** The hosted computer's agent tools for the phone, with the plan read from the account as it is now. */
const hostedServer = () => {
  const hosted = new HostedRoutines({
    call: async () => ({ ok: false, status: 404, body: {} }),
    hasKey: () => true,
  });
  vi.spyOn(hosted, "find").mockReturnValue(ROW);
  const create = vi.fn(
    async (_input: RoutineCreateInput, _options?: unknown) =>
      ({ id: "r1" }) as unknown as Routine
  );
  const server = new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["cronjob"]),
    workspacePath: () => null,
    workspaceId: () => null,
    planTier: () => abacusPlanTier(cachedAbacusAccount()),
    channelForSession: (session: string) =>
      session === PHONE ? WHATSAPP_CHANNEL : null,
    routines: {
      defaultRunner: () => "hosted",
      hostedOnly: () => true,
      create,
      hosted,
      alwaysOnNote: async () => null,
    },
  } as never);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await server.executeTool(name, args, PHONE)) as {
      content: Array<{ text?: string }>;
      isError?: boolean;
    };
    return {
      text: result.content.map((part) => part.text ?? "").join("\n"),
      isError: result.isError === true,
    };
  };
  return { call, create };
};

const KINDS: Array<Record<string, unknown>> = [
  { prompt: "Call mom", reminder_text: "Call mom", in_minutes: 30 },
  {
    prompt: "Call mom",
    reminder_text: "Call mom",
    run_at: "2099-01-01T08:00:00Z",
  },
  {
    prompt: "Water the plants",
    schedule: "0 18 * * 1",
    timezone: "Asia/Kolkata",
  },
  {
    prompt: "My daily brief: calendar and top emails",
    schedule: "0 8 * * *",
    timezone: "Asia/Kolkata",
  },
];

/** The server times the routine and hands a fire to this computer's routine lane; its answer goes back for delivery. */
const fire = async (input: RoutineCreateInput, answer: string) => {
  const calls: Array<Record<string, unknown>> = [];
  const run = vi.fn(async (_request: HostedRunRequest) => ({
    outcome: "completed" as const,
    text: answer,
  }));
  const lane = new RoutineEntryRunner({
    call: (async (body: Record<string, unknown>) => {
      calls.push(body);
      return (body.action === "routine_start" ? { result: "ok" } : {}) as never;
    }) as never,
    hasKey: () => true,
    run,
    activity: () => {},
    log: () => {},
  });
  lane.take({
    kind: "routine",
    handle: "h1",
    routine: {
      run_key: "rk1",
      name: input.name ?? "Routine",
      prompt: input.prompt,
      notify: input.notify ?? "always",
      deadline_in: 900,
      tz: input.timezone ?? "UTC",
    },
  });
  await lane.idle();
  return {
    run,
    result: calls.find((body) => body.action === "routine_result"),
  };
};

describe("reminders and routines from WhatsApp", () => {
  it("refuses every kind on the free plan, with the plan's pitch to give", async () => {
    const { call, create } = hostedServer();
    for (const kind of KINDS) {
      const { text, isError } = await call("cronjob", {
        action: "create",
        ...kind,
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/Call paid_feature with feature routines/);
    }
    expect(create).not.toHaveBeenCalled();
  });

  for (const plan of ["Basic", "Pro", "Max"]) {
    it(`takes ${plan} the moment the payment lands: the next create of every kind is made, fires and is delivered`, async () => {
      const { call, create } = hostedServer();
      expect(
        (await call("cronjob", { action: "create", ...KINDS[0] })).isError
      ).toBe(true);

      // The server's `upgraded` event, as the phone lane hands it over.
      accountTier = plan.toLowerCase();
      const events = new StepEvents({
        originKind: () => "phone",
        deliver: () => {},
        landed: (event) => {
          if (event.event === "upgraded")
            accountMovedPlan(
              typeof event.facts.plan === "string" ? event.facts.plan : null
            );
        },
        alive: () => true,
        refs: { read: () => ({}), write: () => {} },
        log: () => {},
      });
      const note = events.claim({
        event: "upgraded",
        step: `upgraded:${plan.toLowerCase()}`,
        facts: {
          plan,
          ios_app: "https://apps.apple.example/chatllm",
          android_app: "https://play.example/chatllm",
          web: "https://apps.example/chatllm/",
        },
      });
      // Read at once, before the turn the note starts: no wait for a fetch.
      expect(abacusPlanTier(cachedAbacusAccount())).toBe(
        plan === "Basic" ? "basic" : "paid"
      );
      expect(note).toMatch(
        /reminders, routines and daily briefs now work right here/
      );
      expect(note).toContain("iPhone: https://apps.apple.example/chatllm");
      expect(note).toContain("Android: https://play.example/chatllm");
      expect(note).toContain("On a computer: https://apps.example/chatllm/");
      expect(note).not.toMatch(/Abacus AI Agent on the web/);

      for (const kind of KINDS) {
        const { text, isError } = await call("cronjob", {
          action: "create",
          ...kind,
        });
        expect(isError).toBe(false);
        expect(text).not.toMatch(/paid_feature/);
      }
      expect(create).toHaveBeenCalledTimes(KINDS.length);
      for (const [input] of create.mock.calls) {
        expect(input).toMatchObject({ runner: "hosted" });
        const { run, result } = await fire(input, `Done: ${input.prompt}`);
        expect(run.mock.calls[0]![0]).toMatchObject({ prompt: input.prompt });
        expect(result).toMatchObject({
          action: "routine_result",
          handle: "h1",
          deliver: true,
          text: `Done: ${input.prompt}`,
        });
      }

      // The plan's own: no Basic pitch any more.
      const handoff = await call("paid_feature", { feature: "app_build" });
      expect(handoff.text).not.toMatch(/The upgrade:|whether they want Basic/);
      expect(handoff.text).toMatch(
        /Their plan includes building websites and apps/
      );
    });
  }
});
