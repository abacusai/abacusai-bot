/**
 * One child pipe as lines (spec 07 review r1 #11): the agent's stdout and its
 * fd 3 compat pipe each get their own splitter, so the taps see exactly the
 * lines the agent wrote whatever the chunking.
 *
 * - **Incremental UTF-8.** Chunks are decoded with one streaming
 *   `TextDecoder` per pipe: a character split across two chunks is joined,
 *   never turned into two replacement characters.
 * - **Line ends.** `\n` ends a line; one `\r` before it is dropped (as the
 *   old `\r\n → \n` normalisation did, across chunk boundaries too).
 * - **Overflow.** A line longer than `maxLineChars` (counted before its
 *   `\n`, a `\r` included) cannot be a record anyone will parse: it is
 *   discarded whole and reported once through `onOverflow`, whether it
 *   arrived in one chunk or many. An unterminated one is dropped as soon as
 *   it passes the limit, along with the rest of it up to the next newline.
 *   (The old tail-keeping truncation could hand a parser the end of a line.)
 * - **End of stream.** `end()` flushes the decoder and delivers a final line
 *   written without its newline (unless it was being discarded).
 */

export interface LineSplitterOptions {
  maxLineChars: number;
  /** An oversize line is being dropped; `chars` of it had arrived. */
  onOverflow?: (chars: number) => void;
}

export class LineSplitter {
  readonly #decoder = new TextDecoder("utf-8");
  readonly #maxLineChars: number;
  readonly #onOverflow: (chars: number) => void;
  #rest = "";
  /** Inside an oversize line: everything up to the next newline goes. */
  #discarding = false;
  #ended = false;

  constructor(options: LineSplitterOptions) {
    this.#maxLineChars = options.maxLineChars;
    this.#onOverflow = options.onOverflow ?? (() => undefined);
  }

  /** The complete lines this chunk finishes, in order. */
  push(chunk: Uint8Array | string): string[] {
    if (this.#ended) return [];
    const text =
      typeof chunk === "string"
        ? chunk
        : this.#decoder.decode(chunk, { stream: true });
    return this.#split(text);
  }

  /** The stream closed: whatever the decoder held, and a last bare line. */
  end(): string[] {
    if (this.#ended) return [];
    const lines = this.#split(this.#decoder.decode());
    this.#ended = true;
    if (!this.#discarding && this.#rest.length > 0)
      lines.push(stripCr(this.#rest));
    this.#rest = "";
    return lines;
  }

  /** Buffered characters of the line in flight (tests, diagnostics). */
  get pending(): number {
    return this.#rest.length;
  }

  #split(input: string): string[] {
    let text = input;
    if (this.#discarding) {
      const newline = text.indexOf("\n");
      if (newline === -1) {
        return [];
      }
      this.#discarding = false;
      text = text.slice(newline + 1);
    }
    if (text.length === 0) return [];
    const parts = (this.#rest + text).split("\n");
    this.#rest = parts.pop() ?? "";
    if (this.#rest.length > this.#maxLineChars) {
      this.#discarding = true;
      this.#onOverflow(this.#rest.length);
      this.#rest = "";
    }
    const lines: string[] = [];
    for (const part of parts) {
      // The same limit as for a line still arriving, whatever the chunking.
      if (part.length > this.#maxLineChars) this.#onOverflow(part.length);
      else lines.push(stripCr(part));
    }
    return lines;
  }
}

const stripCr = (line: string): string =>
  line.endsWith("\r") ? line.slice(0, -1) : line;
