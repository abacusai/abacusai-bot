/**
 * How the phone loop's turns end when the model cannot answer them, against
 * the real loop and a model server on this machine.
 *
 * A long build on the phone must never leave the chat unable to answer.
 *
 * A build that looked at its work after every change read one screenshot
 * after another. Each image stayed in the transcript at full size, the
 * request grew past the server's size limit, and the server refused it
 * ("413 Maximum request body size exceeded"). That refusal was not read as an
 * outgrown transcript, so nothing compacted, and every later message re-sent
 * the same transcript and was refused the same way: the chat was over.
 *
 * A turn the account cannot pay for says so: its reply names the cause, so
 * the chat app gives the account's own message (what ran out, where to pay)
 * rather than "something went wrong, send that again", which fails the same
 * way every time it is followed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { crc32, deflateSync } from "node:zlib";

import {
  FakeProvider,
  type RecordedCall,
} from "@abacus-ai/test-support/fake-provider";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const fake = vi.hoisted(() => ({ baseUrl: "" }));
vi.mock("../abacus-endpoint.js", async (importActual) => ({
  ...(await importActual<typeof import("../abacus-endpoint.js")>()),
  abacusV1BaseUrl: () => fake.baseUrl,
}));

const { AgentMode } = await import("../protocol.js");
type DesktopEvent = import("../protocol.js").DesktopEvent;
type AgentEvent = import("../protocol.js").AgentEvent;
const { PhoneSession } = await import("./phone-session.js");
const { IMAGE_LIMIT } = await import("../extensions/request-size.js");

const MODEL = "abacus-vision-1";
/** The server's limit on one request, scaled down with the screenshots. */
const BODY_LIMIT = 5 * 1024 * 1024;
const REFUSED = {
  fail: {
    status: 413,
    message: "Maximum request body size 67108864 exceeded.",
  },
};

/** A PNG of random pixels: it does not compress, so its size is its area. */
function noisePng(side: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < side; y++) {
    const row = Buffer.alloc(1 + side * 3);
    for (let i = 1; i < row.length; i++)
      row[i] = Math.floor(Math.random() * 256);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let provider: FakeProvider;
let home: string;
let work: string;

const bodySize = (call: RecordedCall): number =>
  Buffer.byteLength(JSON.stringify(call.body));
const isSummary = (call: RecordedCall): boolean =>
  JSON.stringify(call.messages[0]?.content ?? "").includes(
    "context summarization assistant"
  );
/** Images the request carries. */
const imagesSent = (call: RecordedCall): number =>
  (JSON.stringify(call.body).match(/"type":"image_url"/g) ?? []).length;

class Phone {
  readonly events: DesktopEvent[] = [];
  readonly session = new PhoneSession({
    cwd: work,
    mode: AgentMode.Auto,
    emit: (event: DesktopEvent) => this.events.push(event),
  } as ConstructorParameters<typeof PhoneSession>[0]);

  agent<T extends AgentEvent["type"]>(
    type: T
  ): Array<Extract<AgentEvent, { type: T }>> {
    return this.events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event)
      .filter(
        (event): event is Extract<AgentEvent, { type: T }> =>
          event.type === type
      );
  }

  /** One message from the phone; resolves with the turn's reply. */
  async message(
    text: string,
    id: string
  ): Promise<Extract<AgentEvent, { type: "turn_reply" }>> {
    const replies = this.agent("turn_reply").length;
    await this.session.send(text, { messageId: id });
    const deadline = Date.now() + 60_000;
    while (this.agent("turn_reply").length === replies) {
      if (Date.now() > deadline) throw new Error("the turn never replied");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.agent("turn_reply").at(-1)!;
  }
}

beforeAll(async () => {
  provider = await FakeProvider.start();
  fake.baseUrl = provider.baseUrl;
  provider.serveModels([
    { id: "route-llm-open", pool: [MODEL] },
    {
      id: MODEL,
      display_name: "Abacus Vision",
      model_type: "text_generation",
      context_length: 1_048_576,
      input_modalities: ["text", "image"],
    },
  ]);
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-oversize-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-oversize-work-"));
  fs.mkdirSync(path.join(home, "agent"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "agent", "settings.json"),
    JSON.stringify({
      retry: { enabled: false, provider: { maxRetries: 0 } },
      // A short recency window, so a compaction here has history to summarise.
      compaction: { keepRecentTokens: 200 },
    })
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
  process.env.ABACUSAI_BOT_PHONE_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "abacusai-bot-oversize-phone-")
  );
}, 60_000);

afterAll(async () => {
  await provider?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
  delete process.env.ABACUSAI_BOT_HOME;
  delete process.env.ABACUS_API_KEY;
  delete process.env.ABACUSAI_BOT_PHONE_DIR;
});

beforeEach(() => {
  provider.calls.splice(0);
});

describe("a long build that keeps looking at screenshots", () => {
  it("keeps every request under the server's limit, and still answers", async () => {
    // 25 screenshots of ~210 KB in base64: past the limit at full size.
    const shots = IMAGE_LIMIT.count + 5;
    for (let i = 0; i < shots; i++)
      fs.writeFileSync(path.join(work, `shot-${i}.png`), noisePng(230));
    let reads = 0;
    provider.script((call) => {
      if (bodySize(call) > BODY_LIMIT) return REFUSED;
      if (isSummary(call)) return { say: "## Goal\nA landing page." };
      // The user's turn: one screenshot after another, then the answer.
      if (call.userText.some((text) => text.includes("build the page"))) {
        if (reads < shots)
          return {
            call: {
              name: "read",
              args: { path: path.join(work, `shot-${reads++}.png`) },
            },
          };
        return { say: "Here is your page." };
      }
      return { say: "ok" };
    });
    const phone = new Phone();
    await phone.session.start();

    const reply = await phone.message("build the page", "m1");

    expect(reply).toMatchObject({ failed: false, text: "Here is your page." });
    expect(await phone.message("thanks!", "m2")).toMatchObject({
      failed: false,
    });
    const turnCalls = provider.calls.filter((call) => !isSummary(call));
    expect(Math.max(...turnCalls.map(bodySize))).toBeLessThan(BODY_LIMIT);
    // The model still sees the newest screenshots, never more than the limit.
    const last = turnCalls.at(-1)!;
    expect(imagesSent(last)).toBeGreaterThan(0);
    expect(imagesSent(last)).toBeLessThanOrEqual(IMAGE_LIMIT.count);
    expect(JSON.stringify(last.body)).toContain("it is no longer shown");
  }, 120_000);
});

describe("a transcript the server refuses for its size", () => {
  it("compacts and answers, and the next message is answered too", async () => {
    // Until a compaction shrinks it, the transcript is too big to send.
    let compacted = false;
    provider.script((call) => {
      if (isSummary(call)) {
        compacted = true;
        return { say: "## Goal\nPlanning a trip." };
      }
      if (call.userText.some((text) => text.includes("first"))) {
        if (!call.userText.some((text) => text.includes("second")))
          return { say: "Noted. ".repeat(400) };
      }
      if (!compacted) return REFUSED;
      return { say: "Answered after compacting." };
    });
    const phone = new Phone();
    await phone.session.start();
    expect(await phone.message("first: plan a trip", "a1")).toMatchObject({
      failed: false,
    });

    const reply = await phone.message("second: book the hotel", "a2");

    expect(compacted).toBe(true);
    expect(reply).toMatchObject({
      failed: false,
      text: "Answered after compacting.",
    });
    expect(await phone.message("third: thanks", "a3")).toMatchObject({
      failed: false,
      text: "Answered after compacting.",
    });
  }, 120_000);
});

describe("a turn the account cannot pay for", () => {
  it("fails naming the credit refusal, so the chat app can say what ran out", async () => {
    provider.script(() => ({
      fail: {
        status: 429,
        message: "You have no remaining credits to use the LLM apis.",
      },
    }));
    const phone = new Phone();
    await phone.session.start();

    const reply = await phone.message("hi", "c1");

    expect(reply).toMatchObject({
      failed: true,
      cause: "credits_exhausted",
      text: "",
    });
  }, 60_000);
});

describe("a turn that runs past its time", () => {
  it("closes out with what it did, never cut off in silence", async () => {
    // The phone lane sets this well inside its own hard cap; a second here.
    process.env.ABACUSAI_BOT_RUN_CAP_MS = "1000";
    try {
      provider.script(async (call) => {
        const asked = JSON.stringify(call.messages.slice(-3));
        if (asked.includes("Stop working now"))
          return {
            say: "I built the first two sections; the third is left. Send a message to carry on.",
          };
        // Busy: one more step every 400 ms, never finishing on its own.
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { call: { name: "ls", args: { path: "." } } };
      });
      const phone = new Phone();
      await phone.session.start();

      const reply = await phone.message("build the whole site", "t1");

      expect(reply).toMatchObject({
        failed: false,
        text: expect.stringContaining("the third is left"),
      });
    } finally {
      delete process.env.ABACUSAI_BOT_RUN_CAP_MS;
    }
  }, 60_000);
});
