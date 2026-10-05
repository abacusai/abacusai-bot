import type { RecorderHandle, Recording } from "./recorder";
export type VoiceState =
  | "idle"
  | "starting"
  | "recording"
  | "transcribing"
  | "error";
export interface VoiceDeps {
  permission(): Promise<boolean>;
  record(signal: AbortSignal): Promise<RecorderHandle>;
  transcribe(clip: Recording): Promise<string>;
  state(value: VoiceState): void;
  transcript(text: string): void;
  error?(code: "microphone" | "transcription"): void;
}
/** End keeps the operation alive; cancellation invalidates every outstanding await. */
export class VoiceOperation {
  #token = 0;
  #abort = new AbortController();
  #recorder: RecorderHandle | null = null;
  #work: Promise<void> | null = null;
  #busy = false;
  constructor(readonly deps: VoiceDeps) {}
  start(): Promise<void> {
    if (this.#busy) return this.#work ?? Promise.resolve();
    this.#busy = true;
    const token = ++this.#token;
    this.#abort = new AbortController();
    this.deps.state("starting");
    const current = () => token === this.#token;
    this.#work = (async () => {
      try {
        const allowed = await this.deps.permission();
        if (!current()) return;
        if (!allowed) throw new Error("permission-denied");
        const recorder = await this.deps.record(this.#abort.signal);
        if (!current()) {
          recorder.cancel();
          return;
        }
        this.#recorder = recorder;
        this.deps.state("recording");
      } catch {
        if (current()) {
          this.#busy = false;
          this.deps.error?.("microphone");
          this.deps.state("error");
        }
      }
    })();
    return this.#work;
  }
  end(): Promise<void> {
    const recorder = this.#recorder;
    if (!recorder) return this.#work ?? Promise.resolve();
    this.#recorder = null;
    const token = this.#token;
    this.deps.state("transcribing");
    this.#work = (async () => {
      try {
        const clip = await recorder.stop();
        if (token !== this.#token) return;
        const text = clip ? await this.deps.transcribe(clip) : "";
        if (token !== this.#token) return;
        if (text) this.deps.transcript(text);
        this.deps.state("idle");
      } catch {
        if (token === this.#token) {
          this.deps.error?.("transcription");
          this.deps.state("error");
        }
      } finally {
        if (token === this.#token) this.#busy = false;
      }
    })();
    return this.#work;
  }
  cancel(): void {
    ++this.#token;
    this.#abort.abort();
    this.#recorder?.cancel();
    this.#recorder = null;
    this.#busy = false;
    this.deps.state("idle");
  }
  async dispose(): Promise<void> {
    this.cancel();
    await this.#work;
  }
}
