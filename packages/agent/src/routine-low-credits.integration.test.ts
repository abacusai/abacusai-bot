/**
 * The last tenth of the credits, through the real session and a scripted
 * model that does what real ones did: told to wrap up, it skips the job.
 * A routine's run is told nothing and does its job; a chat is told once.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FakeProvider,
  type RecordedCall,
} from "@abacus-ai/test-support/fake-provider";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ baseUrl: "" }));
vi.mock("./abacus-endpoint.js", async (importActual) => ({
  ...(await importActual<typeof import("./abacus-endpoint.js")>()),
  abacusV1BaseUrl: () => fake.baseUrl,
}));

const { AgentMode } = await import("./protocol.js");
type DesktopEvent = import("./protocol.js").DesktopEvent;
const { AbacusBotSession } = await import("./session.js");
const { setHostCreditBalance } = await import("./credit-balance.js");

const ABACUS_MODEL = "abacus-open-1";
const WRAP_UP = "Credit check";

let provider: FakeProvider;
let home: string;

const told = (call: RecordedCall): boolean =>
  JSON.stringify(call.messages).includes(WRAP_UP);

const start = async () => {
  const events: DesktopEvent[] = [];
  const session = new AbacusBotSession({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-low-credits-")),
    mode: AgentMode.Yolo,
    emit: (event: DesktopEvent) => events.push(event),
  } as ConstructorParameters<typeof AbacusBotSession>[0]);
  await session.start();
  const turn = async (text: string): Promise<RecordedCall[]> => {
    const before = provider.calls.length;
    const done = () =>
      events.filter(
        (event) =>
          event.type === "event" && event.event.type === "turn_complete"
      ).length;
    const closed = done();
    await session.send(text);
    const deadline = Date.now() + 15_000;
    while (done() === closed) {
      if (Date.now() > deadline) throw new Error("turn never completed");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return provider.calls.slice(before);
  };
  return { session, turn };
};

beforeAll(async () => {
  provider = await FakeProvider.start();
  fake.baseUrl = provider.baseUrl;
  provider.serveModels([
    { id: "route-llm-open", pool: [ABACUS_MODEL] },
    {
      id: ABACUS_MODEL,
      display_name: "Abacus Open",
      model_type: "text_generation",
      context_length: 131_072,
    },
  ]);
  provider.script((call) =>
    told(call)
      ? { say: "Credits are low, so I skipped this check." }
      : call.messages.at(-1)?.role === "tool"
        ? { say: "Checked the folder." }
        : { call: { name: "ls", args: { path: "." } } }
  );
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-low-home-"));
  fs.mkdirSync(path.join(home, "agent"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "agent", "settings.json"),
    JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } })
  );
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ defaultModel: "openllm/auto", customProviders: [] })
  );
  fs.writeFileSync(
    path.join(home, "user-language.json"),
    JSON.stringify({ language: { name: "English", source: "user" } })
  );
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUS_API_KEY = "test-abacus-key";
  // Under a tenth left.
  setHostCreditBalance({ remaining: 106, granted: 2000, at: Date.now() });
}, 60_000);

afterEach(() => {
  delete process.env.ABACUSAI_BOT_NOBODY_PRESENT;
});

afterAll(async () => {
  await provider?.close();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.ABACUSAI_BOT_HOME;
  delete process.env.ABACUS_API_KEY;
});

it("a routine's run in the last tenth hears no wrap-up and does its job", async () => {
  process.env.ABACUSAI_BOT_NOBODY_PRESENT = "1";
  const { session, turn } = await start();

  const calls = await turn("Run the check");
  await session.stop();

  expect(calls.some(told)).toBe(false);
  expect(calls.at(-1)?.messages.at(-1)?.role).toBe("tool");
});

it("a chat in the last tenth is told once, and wraps up", async () => {
  const { session, turn } = await start();

  const first = await turn("Build it");
  const second = await turn("And the rest?");
  await session.stop();

  expect(first.some(told)).toBe(true);
  const nudges = (call: RecordedCall | undefined): number =>
    JSON.stringify(call?.messages ?? []).split(WRAP_UP).length - 1;
  expect(nudges(second.at(-1))).toBe(1);
});
