import { describe, expect, it, vi } from "vitest";

import { VoiceOperation } from "./operation";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const setup = () => {
  const recorder = {
    stop: vi.fn(async () => ({ audio: new Blob(), durationMs: 1 })),
    cancel: vi.fn(),
  };
  const deps = {
    permission: vi.fn(async () => true),
    record: vi.fn(async () => recorder),
    transcribe: vi.fn(async () => "hello"),
    state: vi.fn(),
    transcript: vi.fn(),
  };
  return { recorder, deps, operation: new VoiceOperation(deps) };
};
describe("R6-T21 dictation operation tokens", () => {
  it("normal End inserts one transcript and does not invalidate the token", async () => {
    const { operation, deps } = setup();
    await operation.start();
    await operation.end();
    await operation.end();
    expect(deps.transcript).toHaveBeenCalledExactlyOnceWith("hello");
    expect(deps.state).toHaveBeenLastCalledWith("idle");
  });
  it("cancel before permission resolves never requests media", async () => {
    const { operation, deps } = setup();
    const gate = deferred<boolean>();
    deps.permission.mockReturnValue(gate.promise);
    const start = operation.start();
    operation.cancel();
    gate.resolve(true);
    await start;
    expect(deps.record).not.toHaveBeenCalled();
  });
  it("late media handle is cancelled", async () => {
    const { operation, deps, recorder } = setup();
    const gate = deferred<typeof recorder>();
    deps.record.mockReturnValue(gate.promise);
    const start = operation.start();
    await Promise.resolve();
    operation.cancel();
    gate.resolve(recorder);
    await start;
    expect(recorder.cancel).toHaveBeenCalledOnce();
    expect(recorder.stop).not.toHaveBeenCalled();
  });
  it("a late transcript cannot enter a replacement operation", async () => {
    const { operation, deps } = setup();
    const gate = deferred<string>();
    deps.transcribe.mockReturnValue(gate.promise);
    await operation.start();
    const ending = operation.end();
    await Promise.resolve();
    operation.cancel();
    await operation.start();
    gate.resolve("stale");
    await ending;
    expect(deps.transcript).not.toHaveBeenCalled();
  });
  it("double click acquires once", async () => {
    const { operation, deps } = setup();
    await Promise.all([operation.start(), operation.start()]);
    expect(deps.record).toHaveBeenCalledOnce();
  });
  it("disposal waits for transcription and discards its result", async () => {
    const { operation, deps } = setup();
    const gate = deferred<string>();
    deps.transcribe.mockReturnValue(gate.promise);
    await operation.start();
    const end = operation.end();
    await Promise.resolve();
    let disposed = false;
    const disposal = operation.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    gate.resolve("stale");
    await Promise.all([end, disposal]);
    expect(deps.transcript).not.toHaveBeenCalled();
  });
});
