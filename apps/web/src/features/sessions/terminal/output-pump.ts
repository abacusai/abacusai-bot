import type { TerminalOutputChunk } from "@abacus-ai/contract/contract/terminal";
export interface OutputView {
  offset: number | undefined;
  write(data: string): void | Promise<void>;
  reset(): void;
}
export const applyTerminalOutput = async (
  view: OutputView,
  chunk: TerminalOutputChunk
): Promise<void> => {
  if (chunk.type === "snapshot") {
    if (chunk.from !== view.offset) view.reset();
    await view.write(chunk.data);
    view.offset = chunk.offset;
  } else if (chunk.type === "data") {
    await view.write(chunk.data);
    view.offset = chunk.offset;
  }
};
export const pumpOutput = async (
  view: OutputView,
  open: (
    offset: number | undefined,
    signal: AbortSignal
  ) => Promise<AsyncIterable<TerminalOutputChunk>>,
  signal: AbortSignal,
  onTerminal: (
    chunk: Extract<TerminalOutputChunk, { type: "exit" | "retired" }>
  ) => void,
  onError: (error: unknown) => void
): Promise<void> => {
  let failures = 0;
  while (!signal.aborted) {
    try {
      for await (const chunk of await open(view.offset, signal)) {
        if (signal.aborted) return;
        if (chunk.type === "exit" || chunk.type === "retired") {
          onTerminal(chunk);
          return;
        }
        await applyTerminalOutput(view, chunk);
        failures = 0;
      }
      if (!signal.aborted)
        throw new Error("Terminal stream ended without retirement");
    } catch (error) {
      if (signal.aborted) return;
      const ms = [0, 250, 1000][failures++];
      if (ms === undefined) {
        onError(error);
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      });
    }
  }
};
