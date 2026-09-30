import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import { EventType } from "@ag-ui/core";
import type { StreamChunk } from "@tanstack/ai";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  INLINE_COMPAT_PREFIX,
  classifyStdoutLine,
  inlineWriter,
  preflightCompat,
  streamWriter,
  type PreflightFs,
} from "./channel.js";
import { aguiEvent, custom, isRunScoped } from "./event.js";
import type { AguiEvent } from "./wire.js";

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code });

describe("compat preflight", () => {
  it("is none without --compat-fd", () => {
    expect(preflightCompat(undefined, "inc")).toBe("none");
  });

  it("chooses fd when the channel takes a synchronous write, and sends the preamble", () => {
    const writes: string[] = [];
    const fake: PreflightFs = {
      fstatSync: () => ({}),
      writeSync: (_fd, data) => {
        const text =
          typeof data === "string" ? data : Buffer.from(data).toString();
        writes.push(text);

        return Buffer.byteLength(text);
      },
    };

    expect(preflightCompat(3, "inc-1", fake)).toBe("fd");
    expect(writes).toEqual([
      "",
      '{"type":"compat.hello","incarnation":"inc-1"}\n',
    ]);
  });

  it.each(["EBADF", "EPIPE", "EINVAL"])(
    "chooses inline when the probe throws %s",
    (code) => {
      const fake: PreflightFs = {
        fstatSync: () => ({}),
        writeSync: () => {
          throw errno(code);
        },
      };

      expect(preflightCompat(3, "inc", fake)).toBe("inline");
    }
  );

  it("chooses inline when fstat fails (fd 3 closed before spawn)", () => {
    const fake: PreflightFs = {
      fstatSync: () => {
        throw errno("EBADF");
      },
      writeSync: () => 0,
    };

    expect(preflightCompat(3, "inc", fake)).toBe("inline");
  });

  it("retries EAGAIN, then succeeds", () => {
    let attempts = 0;
    const fake: PreflightFs = {
      fstatSync: () => ({}),
      writeSync: (_fd, data) => {
        attempts += 1;
        if (attempts === 2) throw errno("EAGAIN");

        return typeof data === "string" ? Buffer.byteLength(data) : data.length;
      },
    };

    expect(preflightCompat(3, "inc", fake)).toBe("fd");
    expect(attempts).toBe(3);
  });

  it("works against a real descriptor, and a closed one falls back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agui-compat-"));
    const file = path.join(dir, "fd3");
    const fd = fs.openSync(file, "w");

    expect(preflightCompat(fd, "inc-real")).toBe("fd");
    fs.closeSync(fd);
    expect(fs.readFileSync(file, "utf8")).toBe(
      '{"type":"compat.hello","incarnation":"inc-real"}\n'
    );
    expect(preflightCompat(fd, "inc-real")).toBe("inline");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("compat writers", () => {
  it("inline prefixes each legacy line with one RS byte, and main strips exactly that", () => {
    const out: string[] = [];
    const writer = inlineWriter((text) => out.push(text));
    const legacy =
      '{"type":"event","event":{"type":"status_changed","status":"idle"}}\n';

    writer.write(legacy);

    expect(out).toEqual([`${INLINE_COMPAT_PREFIX}${legacy}`]);
    expect(classifyStdoutLine(out[0]!.trimEnd())).toEqual({
      kind: "compat",
      line: legacy.trimEnd(),
    });
    expect(classifyStdoutLine('{"type":"CUSTOM"}').kind).toBe("agui");
  });

  it("reports an asynchronous write failure once and stops writing", () => {
    const stream = new PassThrough();
    const lost = vi.fn();
    const writer = streamWriter(stream, lost);
    const written: string[] = [];

    stream.on("data", (chunk: Buffer) => written.push(chunk.toString()));
    writer.write("a\n");
    stream.emit("error", new Error("EPIPE"));
    stream.emit("error", new Error("EPIPE again"));
    writer.write("b\n");

    expect(lost).toHaveBeenCalledTimes(1);
    expect(written.join("")).toBe("a\n");
  });
});

describe("events", () => {
  it("are canonical @ag-ui/core events assignable to TanStack's StreamChunk", () => {
    expectTypeOf<AguiEvent>().toExtend<StreamChunk>();

    const started = aguiEvent(EventType.RUN_STARTED, {
      threadId: "t",
      runId: "r",
    });
    const chunk: StreamChunk = started;

    expect(chunk.type).toBe("RUN_STARTED");
  });

  it("scopes CUSTOM names as the spec table says", () => {
    expect(
      isRunScoped(custom("tool.output", { toolCallId: "x", output: "y" }))
    ).toBe(true);
    expect(
      isRunScoped(custom("agent.status", { status: "idle" as never }))
    ).toBe(false);
    expect(
      isRunScoped(
        aguiEvent(EventType.TEXT_MESSAGE_CONTENT, {
          messageId: "m",
          delta: "d",
        })
      )
    ).toBe(true);
    expect(isRunScoped(aguiEvent(EventType.STATE_DELTA, { delta: [] }))).toBe(
      false
    );
  });
});
