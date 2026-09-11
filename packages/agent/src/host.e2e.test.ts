import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
/**
 * The NDJSON host, run as the desktop app runs it.
 *
 * This is the app's entire interface to the agent, and it was covered by
 * nothing: `host.ts` had no test, so the protocol the desktop depends on was
 * only ever exercised by launching Electron. These spawn the built
 * `dist/index.js` and speak the protocol to it over stdio.
 *
 * They are also the other half of the CLI's alignment check. The CLI withholds
 * the tools that need a host to render; the point of doing it there rather than
 * removing them is that the desktop still gets them, and that only means
 * something if something asserts it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FakeProvider,
  fakeProviderConfig,
  type Reply,
} from "@abacus-ai/test-support/fake-provider";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { DesktopCommand, DesktopEvent } from "./protocol.js";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const AGENT = path.join(PACKAGE_ROOT, "dist", "main.js");

let provider: FakeProvider;
let home: string;

/** One running agent, with the events it has emitted so far. */
class Host {
  readonly events: DesktopEvent[] = [];
  private buffer = "";

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    readonly cwd: string
  ) {}

  static start(cwd: string, args: string[] = []): Host {
    const child = spawn(process.execPath, [AGENT, ...args], {
      cwd,
      env: {
        ...process.env,
        ABACUSAI_BOT_HOME: home,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const host = new Host(child, cwd);

    child.stdout.on("data", (chunk) => host.ingest(String(chunk)));
    // Drained so a full stderr pipe cannot block the child.
    child.stderr.on("data", () => undefined);

    return host;
  }

  send(command: DesktopCommand): void {
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  /** Raw bytes, for the malformed-input case. */
  sendRaw(line: string): void {
    this.child.stdin.write(`${line}\n`);
  }

  /** Wait for the first event matching `match`, or fail on the deadline. */
  async waitFor(
    match: (event: DesktopEvent) => boolean,
    timeoutMs = 20_000
  ): Promise<DesktopEvent> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const found = this.events.find(match);

      if (found != null) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out; saw: ${this.events.map((event) => event.type).join(", ")}`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Every agent event of one type, unwrapped from the `event` envelope. */
  agentEvents<T extends string>(type: T): Array<Record<string, unknown>> {
    return this.events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event as unknown as Record<string, unknown>)
      .filter((event) => event.type === type);
  }

  async stop(): Promise<void> {
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve(undefined);
      }, 5_000);

      this.child.on("exit", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;

    const lines = this.buffer.split("\n");

    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim().length === 0) continue;

      try {
        this.events.push(JSON.parse(line) as DesktopEvent);
      } catch {
        throw new Error(
          `stdout is the protocol, and this line is not an event: ${line.slice(0, 200)}`
        );
      }
    }
  }
}

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-host-"));
}

/**
 * Drive the parent to `document`, then drive the document sub-agent to the
 * first tool that needs the host — which is where a real render request comes
 * from. Both agents share this provider, so they are told apart by their tools.
 */
function driveDocumentTask(): (call: { tools: string[] }) => Reply {
  let asked = false;

  return (call) => {
    if (call.tools.includes("document")) {
      return {
        call: {
          name: "document",
          args: { brief: "a short report", output_path: "out.pdf" },
        },
      };
    }

    const templates = call.tools.find((name) => /template/i.test(name));

    if (templates != null && !asked) {
      asked = true;

      return { call: { name: templates, args: {} } };
    }

    return { say: "done" };
  };
}

let running: Host[] = [];

function start(cwd: string, args: string[] = []): Host {
  const host = Host.start(cwd, args);

  running.push(host);

  return host;
}

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-host-home-"));
  fs.writeFileSync(
    path.join(home, "config.json"),
    fakeProviderConfig(provider),
    "utf8"
  );
}, 180_000);

afterAll(async () => {
  await provider?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(running.map((host) => host.stop()));
  running = [];
  provider.calls.length = 0;
  provider.script(() => ({ say: "ok" }));
});

describe("starting up", () => {
  it("announces itself with the model, the mode and its session ids", async () => {
    const host = start(workspace(), ["--permission-mode", "YOLO"]);
    const ready = (await host.waitFor(
      (event) => event.type === "ready"
    )) as Extract<DesktopEvent, { type: "ready" }>;

    expect(ready.model).toBe("fake/fake-1");
    expect(ready.mode).toBe("YOLO");
    // The desktop keys the conversation on these; without them nothing on disk
    // connects a conversation to the log that explains what it did.
    expect(ready.agentSessionId).toBeTruthy();
  });

  it("publishes the skill list and the MCP roster", async () => {
    const host = start(workspace());

    await host.waitFor((event) => event.type === "skills_loaded");
    await host.waitFor((event) => event.type === "mcp_servers");
  });
});

describe("the toolset the desktop gets", () => {
  it("still includes the components the CLI withholds", async () => {
    const host = start(workspace(), ["--permission-mode", "YOLO"]);

    host.send({ type: "send", message: "hello" });
    await host.waitFor(
      (event) => event.type === "event" && event.event.type === "turn_complete"
    );

    const tools = provider.firstCall?.tools ?? [];

    // The CLI drops these because nothing there can answer a render request.
    // The desktop can, so this is what makes that a routing decision rather
    // than a capability the product lost.
    expect(tools).toEqual(
      expect.arrayContaining(["document", "ppt", "design"])
    );
    expect(tools).toEqual(expect.arrayContaining(["grep", "find", "ls"]));
  });
});

describe("a turn", () => {
  it("streams the reply and then says it is done", async () => {
    const host = start(workspace(), ["--permission-mode", "YOLO"]);

    provider.script(() => ({ say: "THE REPLY" }));
    host.send({ type: "send", message: "hello" });

    await host.waitFor(
      (event) => event.type === "event" && event.event.type === "turn_complete"
    );

    const text = host
      .agentEvents("text_delta")
      .map((event) => String(event.content ?? ""))
      .join("");

    expect(text).toContain("THE REPLY");
  });

  it("ignores an empty message rather than spending a call on it", async () => {
    const host = start(workspace(), ["--permission-mode", "YOLO"]);

    await host.waitFor((event) => event.type === "ready");
    host.send({ type: "send", message: "   " });
    await new Promise((resolve) => setTimeout(resolve, 750));

    expect(provider.calls).toHaveLength(0);
  });

  it("survives a malformed command line instead of dying on it", async () => {
    const host = start(workspace(), ["--permission-mode", "YOLO"]);

    await host.waitFor((event) => event.type === "ready");
    host.sendRaw("{not json at all");
    provider.script(() => ({ say: "still here" }));
    host.send({ type: "send", message: "hello" });

    await host.waitFor(
      (event) => event.type === "event" && event.event.type === "turn_complete"
    );
  });
});

describe("host services", () => {
  it("asks the host to render, and takes the answer", async () => {
    const host = start(workspace(), ["--permission-mode", "YOLO"]);

    provider.script(driveDocumentTask());

    host.send({ type: "send", message: "write me a report" });

    const request = (await host.waitFor(
      (event) => event.type === "host_service_request",
      45_000
    )) as Extract<DesktopEvent, { type: "host_service_request" }>;

    expect(request.requestId).toBeTruthy();

    // Answering is what the desktop does and the CLI cannot, which is the whole
    // reason the CLI does not register the tool.
    host.send({
      type: "host_service_response",
      requestId: request.requestId,
      ok: false,
      error: "no renderer in this test",
    });

    await host.waitFor(
      (event) => event.type === "event" && event.event.type === "turn_complete",
      45_000
    );
  }, 90_000);

  it("does not wedge the turn when the host never answers", async () => {
    const host = start(workspace(), ["--permission-mode", "YOLO"]);

    provider.script(driveDocumentTask());

    host.send({ type: "send", message: "write me a report" });
    await host.waitFor(
      (event) => event.type === "host_service_request",
      45_000
    );

    // Nothing answers. `stop` has to settle it, because the deadline is minutes
    // away and the user is not waiting for it.
    host.send({ type: "stop" });

    await host.waitFor(
      (event) =>
        event.type === "event" &&
        event.event.type === "status_changed" &&
        event.event.status === "idle",
      45_000
    );
  }, 90_000);
});

describe("approvals", () => {
  it("asks, blocks, and applies the answer", async () => {
    const cwd = workspace();
    const host = start(cwd, ["--permission-mode", "DEFAULT"]);

    provider.scriptSequence([
      {
        call: { name: "write", args: { path: "approved.txt", content: "yes" } },
      },
      { say: "written" },
    ]);

    host.send({ type: "send", message: "write a file" });

    const ask = (await host.waitFor(
      (event) => event.type === "permission_needed"
    )) as Extract<DesktopEvent, { type: "permission_needed" }>;

    expect(ask.request.type).toBe("write_file");
    // Genuinely blocking: the file must not exist while the question is open.
    expect(fs.existsSync(path.join(cwd, "approved.txt"))).toBe(false);

    host.send({
      type: "permission_response",
      permissionId: ask.permissionId,
      decision: "accept",
    });
    await host.waitFor(
      (event) => event.type === "event" && event.event.type === "turn_complete"
    );

    expect(fs.readFileSync(path.join(cwd, "approved.txt"), "utf8")).toBe("yes");
  });

  it("asks before a sub-agent runs, and refusing stops it", async () => {
    const cwd = workspace();
    const host = start(cwd, ["--permission-mode", "DEFAULT"]);

    provider.scriptSequence([
      { call: { name: "delegate_task", args: { task: "create ESCAPED.txt" } } },
      { say: "refused" },
    ]);

    host.send({ type: "send", message: "delegate something" });

    const ask = (await host.waitFor(
      (event) => event.type === "permission_needed"
    )) as Extract<DesktopEvent, { type: "permission_needed" }>;

    expect(ask.request.displayName).toContain("unsupervised");

    host.send({
      type: "permission_response",
      permissionId: ask.permissionId,
      decision: "reject",
    });
    await host.waitFor(
      (event) => event.type === "event" && event.event.type === "turn_complete"
    );

    expect(fs.existsSync(path.join(cwd, "ESCAPED.txt"))).toBe(false);
  });
});

describe("set_mode", () => {
  it("changes the mode and reports the change", async () => {
    const host = start(workspace(), ["--permission-mode", "DEFAULT"]);

    await host.waitFor((event) => event.type === "ready");
    host.send({ type: "set_mode", mode: "PLAN" });

    await host.waitFor(
      (event) =>
        event.type === "event" &&
        event.event.type === "mode_changed" &&
        event.event.mode === "PLAN"
    );
  });

  it("says so and stays put when the mode is not one it knows", async () => {
    const host = start(workspace(), ["--permission-mode", "PLAN"]);

    await host.waitFor((event) => event.type === "ready");
    host.send({ type: "set_mode", mode: "planing" });

    const warning = await host.waitFor(
      (event) => event.type === "event" && event.event.type === "notification"
    );

    expect(JSON.stringify(warning)).toContain("not a mode");

    // The old fallback was Normal, which is the mode a typo could least afford
    // to become: it would have quietly taken a plan-mode session writable.
    const modes = host.agentEvents("mode_changed").map((event) => event.mode);

    expect(modes.every((mode) => mode === "PLAN")).toBe(true);
  });
});

describe("a message sent mid-turn", () => {
  const queueEvents = (host: Host) =>
    host.events.filter(
      (event): event is Extract<DesktopEvent, { type: "queue_updated" }> =>
        event.type === "queue_updated"
    );

  it("steers the running turn: lands after the tool result, before the next model call", async () => {
    const host = start(workspace(), ["--permission-mode", "YOLO"]);

    provider.script(driveDocumentTask());

    host.send({ type: "send", message: "write me a report" });

    // The turn is parked inside a tool, waiting on the host. Anything sent
    // now cannot be a new turn; it has to reach the model with the result.
    const request = (await host.waitFor(
      (event) => event.type === "host_service_request",
      45_000
    )) as Extract<DesktopEvent, { type: "host_service_request" }>;

    host.send({ type: "send", message: "also, keep it to one page" });

    await host.waitFor(
      (event) =>
        event.type === "queue_updated" &&
        event.messages.some(
          (entry) =>
            entry.message === "also, keep it to one page" &&
            entry.waitingFor === "step"
        )
    );

    host.send({
      type: "host_service_response",
      requestId: request.requestId,
      ok: false,
      error: "no renderer in this test",
    });

    await host.waitFor(
      (event) =>
        event.type === "event" &&
        event.event.type === "user_message_steered" &&
        event.event.content === "also, keep it to one page",
      45_000
    );
    await host.waitFor(
      (event) =>
        event.type === "event" &&
        event.event.type === "status_changed" &&
        event.event.status === "idle",
      45_000
    );

    // Delivered to the model inside the same turn, not as a turn of its own.
    expect(
      provider.calls.some((call) =>
        call.userText.includes("also, keep it to one page")
      )
    ).toBe(true);
    expect(host.agentEvents("user_message_dequeued")).toHaveLength(0);
    expect(queueEvents(host).at(-1)?.messages).toEqual([]);
  }, 90_000);

  it("waits behind a permission prompt, then steers once it is answered", async () => {
    const cwd = workspace();
    const host = start(cwd, ["--permission-mode", "DEFAULT"]);

    provider.scriptSequence([
      {
        call: { name: "write", args: { path: "approved.txt", content: "yes" } },
      },
      { say: "written" },
    ]);

    host.send({ type: "send", message: "write a file" });

    const ask = (await host.waitFor(
      (event) => event.type === "permission_needed"
    )) as Extract<DesktopEvent, { type: "permission_needed" }>;

    // A steer queued now would sit behind the prompt and could be read as
    // the answer to it, so it is parked instead.
    host.send({ type: "send", message: "and then list the folder" });
    await host.waitFor(
      (event) =>
        event.type === "queue_updated" &&
        event.messages.some((entry) => entry.waitingFor === "permission")
    );

    host.send({
      type: "permission_response",
      permissionId: ask.permissionId,
      decision: "accept",
    });

    await host.waitFor(
      (event) =>
        event.type === "queue_updated" &&
        event.messages.some((entry) => entry.waitingFor === "step")
    );
    await host.waitFor(
      (event) =>
        event.type === "event" &&
        event.event.type === "status_changed" &&
        event.event.status === "idle",
      45_000
    );

    expect(fs.readFileSync(path.join(cwd, "approved.txt"), "utf8")).toBe("yes");
    expect(
      provider.calls.some((call) =>
        call.userText.includes("and then list the folder")
      )
    ).toBe(true);
  }, 90_000);

  it("can be edited or withdrawn on its way, and survives Stop as the next turn", async () => {
    const host = start(workspace(), ["--permission-mode", "YOLO"]);

    provider.script(driveDocumentTask());

    host.send({ type: "send", message: "write me a report" });
    await host.waitFor(
      (event) => event.type === "host_service_request",
      45_000
    );

    host.send({ type: "send", message: "first thought" });
    host.send({ type: "send", message: "second thought" });
    await host.waitFor(
      (event) => event.type === "queue_updated" && event.messages.length === 2
    );

    host.send({
      type: "update_queue_item",
      index: 0,
      message: "better thought",
    });
    await host.waitFor(
      (event) =>
        event.type === "queue_updated" &&
        event.messages[0]?.message === "better thought"
    );

    host.send({ type: "remove_from_queue", index: 1 });
    await host.waitFor(
      (event) =>
        event.type === "queue_updated" &&
        event.messages.length === 1 &&
        event.messages[0]?.message === "better thought"
    );

    // Stop ends the reply, not the request: what is still on its way runs
    // as the next turn, once, in the shape it was last edited to.
    host.send({ type: "stop" });
    await host.waitFor(
      (event) =>
        event.type === "event" &&
        event.event.type === "user_message_dequeued" &&
        event.event.content === "better thought",
      45_000
    );
    await host.waitFor(
      (event) => event.type === "queue_updated" && event.messages.length === 0
    );
    await host.waitFor(
      () =>
        provider.calls.some((call) => call.userText.includes("better thought")),
      45_000
    );

    expect(
      provider.calls.some(
        (call) =>
          call.userText.includes("first thought") ||
          call.userText.includes("second thought")
      )
    ).toBe(false);
  }, 90_000);

  // The report: Stop, send "Sort them by time", nothing happens; send a
  // follow-up, and "Sort them by time" runs again under a second bubble.
  // The desktop reports idle the instant Stop is pressed, while the host is
  // still aborting — a message sent in that window fell into the queue and
  // sat there until the *next* turn ended.
  it("runs a message sent while Stop is landing, once, as the next turn", async () => {
    const host = start(workspace(), ["--permission-mode", "YOLO"]);

    provider.script(driveDocumentTask());

    host.send({ type: "send", message: "write me a report" });
    await host.waitFor(
      (event) => event.type === "host_service_request",
      45_000
    );

    // Stop, and in the same breath the next message. The host has not
    // finished aborting when the send arrives.
    host.send({ type: "stop" });
    host.send({ type: "send", message: "sort them by time" });

    await host.waitFor(
      (event) =>
        event.type === "event" &&
        event.event.type === "status_changed" &&
        event.event.status === "idle",
      45_000
    );
    // The stop's idle, then the new turn's idle: wait for a request that
    // carries the new message.
    await host.waitFor(
      () =>
        provider.calls.some((call) =>
          call.userText.includes("sort them by time")
        ),
      45_000
    );
    const idles = () =>
      host
        .agentEvents("status_changed")
        .filter((event) => event.status === "idle").length;
    await host.waitFor(() => idles() >= 2, 45_000);

    const runs = provider.calls.filter((call) =>
      call.userText.includes("sort them by time")
    );

    expect(runs.length).toBeGreaterThan(0);
    // Every request in that turn carries the message once, never twice.
    expect(
      runs.every(
        (call) =>
          call.userText.filter((text) => text === "sort them by time")
            .length === 1
      )
    ).toBe(true);
    // The desktop already drew this bubble when it sent; no second one.
    expect(host.agentEvents("user_message_dequeued")).toHaveLength(0);
    expect(queueEvents(host).at(-1)?.messages).toEqual([]);
  }, 90_000);

  it("clears the queue on request", async () => {
    const host = start(workspace(), ["--permission-mode", "YOLO"]);

    await host.waitFor((event) => event.type === "ready");
    host.send({ type: "get_queue" });
    await host.waitFor((event) => event.type === "queue_updated");
    host.send({ type: "clear_queue" });
    await host.waitFor(
      (event) => event.type === "queue_updated" && event.messages.length === 0
    );
  });
});
