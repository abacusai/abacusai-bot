/**
 * A disk that fills during a turn, through the real session, pi and its
 * tools, against the loopback model. Every turn must end on the full-disk
 * card, and the model must not be left writing: whether the chat's own save
 * failed or a tool's write did.
 */
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import {
  FakeProvider,
  fakeProviderConfig,
  type Reply,
} from "@abacus-ai/test-support/fake-provider";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { AgentMode } = await import("../protocol.js");
type DesktopEvent = import("../protocol.js").DesktopEvent;
type AgentEvent = import("../protocol.js").AgentEvent;
const { AbacusBotSession } = await import("../session.js");

const nodeFs = createRequire(import.meta.url)("node:fs") as typeof fs;
const restores: Array<() => void> = [];

const enospc = (): never => {
  throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
    errno: -28,
    code: "ENOSPC",
    syscall: "write",
  });
};

/** From now on every write fails as Node fails it on a full disk, pi's session file included. */
const fillDisk = (): void => {
  restores.push(
    vi.spyOn(nodeFs, "writeFileSync").mockImplementation(enospc).mockRestore,
    vi.spyOn(nodeFs, "appendFileSync").mockImplementation(enospc).mockRestore
  );
  syncBuiltinESMExports();
};

/** The disk the chat is saved on reports almost no room left. */
const reportLittleRoom = (): void => {
  const real = nodeFs.statfsSync.bind(nodeFs);
  restores.push(
    vi.spyOn(nodeFs, "statfsSync").mockImplementation(((
      target: fs.PathLike
    ) => ({
      ...real(target),
      bavail: 10,
      bsize: 4096,
    })) as typeof fs.statfsSync).mockRestore
  );
  syncBuiltinESMExports();
};

const TOOL_OUT_OF_SPACE =
  "python3 -c \"import sys; sys.stderr.write('OSError: [Errno 28] No space left on device\\n'); sys.exit(1)\"";

let provider: FakeProvider;
let home: string;

class Chat {
  readonly events: DesktopEvent[] = [];
  readonly session = new AbacusBotSession({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-disk-")),
    mode: AgentMode.Yolo,
    emit: (event: DesktopEvent) => this.events.push(event),
  } as ConstructorParameters<typeof AbacusBotSession>[0]);

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

  async turn(text: string): Promise<void> {
    const ended = this.agent("turn_complete").length;
    await this.session.send(text);
    const deadline = Date.now() + 15_000;
    while (this.agent("turn_complete").length === ended) {
      if (Date.now() > deadline) throw new Error("turn never completed");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** A chat whose first turn is answered with room to spare: its session file exists. */
const chat = async (): Promise<Chat> => {
  provider.script(() => ({ say: "first answer" }));
  const started = new Chat();
  await started.session.start();
  await started.turn("hello");
  provider.calls.length = 0;
  return started;
};

/** What the model was shown after its last tool call. */
const lastToolResult = (index: number): string =>
  JSON.stringify(provider.calls[index]?.messages.at(-1)?.content ?? "");

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-disk-home-"));
  fs.mkdirSync(path.join(home, "agent"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "agent", "settings.json"),
    JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } })
  );
  fs.writeFileSync(
    path.join(home, "config.json"),
    fakeProviderConfig(provider)
  );
  fs.writeFileSync(
    path.join(home, "user-language.json"),
    JSON.stringify({ language: { name: "English", source: "user" } })
  );
  process.env.ABACUSAI_BOT_HOME = home;
}, 60_000);

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  syncBuiltinESMExports();
});

afterAll(async () => {
  await provider?.close();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.ABACUSAI_BOT_HOME;
});

describe("a disk that fills mid-turn", () => {
  it("the chat's own save fails after a tool: the turn ends on the card at once, and no provider retry is claimed", async () => {
    const c = await chat();
    const stderr = vi.spyOn(process.stderr, "write");
    restores.push(stderr.mockRestore);
    provider.script((call): Reply => {
      if (call.messages.at(-1)?.role !== "tool")
        return { call: { name: "bash", args: { command: "echo step" } } };
      // The disk filled while the tool ran: the model's next message cannot be saved.
      fillDisk();
      return {
        say: "Here is what I found. ".repeat(200),
        call: { name: "bash", args: { command: "echo next" } },
      };
    });

    await c.turn("check my site");

    const said = stderr.mock.calls.map((args) => String(args[0])).join("");
    expect(said).not.toMatch(/retrying/);
    expect(said).toMatch(/\[disk\] the disk is full/);
    expect(c.agent("error").at(-1)?.error).toMatchObject({
      cause: "disk_full",
    });
    expect(c.agent("turn_complete").at(-1)?.outcome).toEqual({
      kind: "failed",
      cause: "disk_full",
    });
    // Nothing ran after the failed save.
    expect(provider.calls).toHaveLength(2);
  }, 30_000);

  it("a tool's write meets the full disk: the model is told, and its answer still ends on the card", async () => {
    const c = await chat();
    reportLittleRoom();
    provider.script((call): Reply =>
      call.messages.at(-1)?.role === "tool"
        ? { say: "The disk is full, so I stopped." }
        : { call: { name: "bash", args: { command: TOOL_OUT_OF_SPACE } } }
    );

    await c.turn("run the checker");

    expect(lastToolResult(1)).toMatch(/The disk on this computer is full/);
    expect(c.agent("error").at(-1)?.error).toMatchObject({
      cause: "disk_full",
      actions: [{ type: "retry", bytesFree: 40960 }],
    });
    expect(c.agent("turn_complete").at(-1)?.outcome).toEqual({
      kind: "failed",
      cause: "disk_full",
    });
  }, 30_000);

  it("told and still writing: the second write stops the run", async () => {
    const c = await chat();
    reportLittleRoom();
    let writes = 0;
    provider.script((): Reply => ({
      call: {
        name: "bash",
        args: { command: `${TOOL_OUT_OF_SPACE} # attempt ${++writes}` },
      },
    }));

    await c.turn("run the checker");

    // Two writes, then no further model call.
    expect(provider.calls).toHaveLength(2);
    expect(c.agent("turn_complete").at(-1)?.outcome).toEqual({
      kind: "failed",
      cause: "disk_full",
    });
  }, 30_000);

  it("a tool that prints the words with room on the disk changes nothing", async () => {
    const c = await chat();
    provider.script((call): Reply =>
      call.messages.at(-1)?.role === "tool"
        ? { say: "That log line is old." }
        : { call: { name: "bash", args: { command: TOOL_OUT_OF_SPACE } } }
    );

    await c.turn("read the old log");

    expect(lastToolResult(1)).not.toMatch(/The disk on this computer is full/);
    expect(c.agent("error")).toHaveLength(0);
    expect(c.agent("turn_complete").at(-1)?.outcome).toEqual({ kind: "reply" });
  }, 30_000);
});
