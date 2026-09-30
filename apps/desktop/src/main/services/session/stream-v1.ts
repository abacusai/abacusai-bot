/**
 * A bounded, read-only reader for v1 transcripts too large to read as one
 * string (cut-over review r2 #8): the file is read in chunks, hashed as it
 * goes (the same fingerprint `fingerprintV1` gives the whole text), and the
 * `segments` array is parsed one element at a time, so no string ever holds
 * more than one segment. Top-level fields other than `segments` are parsed
 * whole (they are small: `version`, `sessionId`, `updatedAt`).
 *
 * Synchronous, like every thread-store read; the caller bounds the file
 * size (`MAX_STREAMED_TRANSCRIPT_BYTES`).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

export type StreamedV1 =
  | {
      status: "ok";
      updatedAt?: string;
      segments: unknown[];
      fingerprint: string;
    }
  | { status: "missing" }
  | { status: "unreadable"; error: string }
  | { status: "invalid" };

class Invalid extends Error {}

type Expecting = "none" | "key" | "colon" | "value" | "element";

/** The scanner: one character at a time, outside the hot path of reads. */
class V1Scanner {
  readonly top: Record<string, unknown> = {};
  readonly segments: unknown[] = [];
  segmentsClosed = false;
  private depth = 0;
  private inString = false;
  private escape = false;
  private expecting: Expecting = "none";
  private key = "";
  private keyBuf: string[] | null = null;
  private capture: string[] | null = null;
  private captureDepth = 0;
  private captureKind: "top" | "segment" = "top";
  private inSegments = false;

  get done(): boolean {
    return this.depth === 0 && !this.inString;
  }

  feed(text: string): void {
    for (const c of text) this.char(c);
  }

  private startCapture(kind: "top" | "segment"): void {
    this.capture = [];
    this.captureDepth = this.depth;
    this.captureKind = kind;
    this.expecting = "none";
  }

  private finishCapture(): void {
    const text = this.capture!.join("");
    this.capture = null;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Invalid();
    }
    if (this.captureKind === "segment") this.segments.push(value);
    else this.top[this.key] = value;
  }

  private char(c: string): void {
    if (this.inString) {
      this.capture?.push(c);
      this.keyBuf?.push(c);
      if (this.escape) this.escape = false;
      else if (c === "\\") this.escape = true;
      else if (c === '"') {
        this.inString = false;
        if (this.keyBuf !== null) {
          this.key = JSON.parse(this.keyBuf.join("")) as string;
          this.keyBuf = null;
          this.expecting = "colon";
        } else if (this.capture !== null && this.depth === this.captureDepth)
          this.finishCapture();
      }
      return;
    }
    if (c === " " || c === "\n" || c === "\r" || c === "\t") {
      this.capture?.push(c);
      return;
    }
    if (this.depth === 0) {
      if (c !== "{" || this.segmentsClosed || Object.keys(this.top).length > 0)
        throw new Invalid();
      this.depth = 1;
      this.expecting = "key";
      return;
    }
    if (c === ",") {
      if (this.capture !== null) {
        if (this.depth !== this.captureDepth) {
          this.capture.push(c);
          return;
        }
        this.finishCapture();
      }
      if (this.depth === 1) this.expecting = "key";
      else if (this.depth === 2 && this.inSegments) this.expecting = "element";
      return;
    }
    if (c === ":" && this.capture === null && this.depth === 1) {
      if (this.expecting !== "colon") throw new Invalid();
      this.expecting = "value";
      return;
    }
    if (c === "}" || c === "]") {
      if (this.capture !== null && this.depth === this.captureDepth)
        // A primitive ends where its container does.
        this.finishCapture();
      this.capture?.push(c);
      this.depth -= 1;
      if (this.capture !== null && this.depth === this.captureDepth)
        this.finishCapture();
      else if (this.inSegments && this.depth === 1 && this.capture === null) {
        this.inSegments = false;
        this.segmentsClosed = true;
      }
      return;
    }
    // The start of a value, or more of one.
    if (this.capture === null) {
      if (this.depth === 1 && this.expecting === "key") {
        if (c !== '"') throw new Invalid();
        this.inString = true;
        this.keyBuf = ['"'];
        return;
      }
      if (this.depth === 1 && this.expecting === "value") {
        if (this.key === "segments" && c === "[") {
          this.inSegments = true;
          this.depth = 2;
          this.expecting = "element";
          return;
        }
        this.startCapture("top");
      } else if (
        this.depth === 2 &&
        this.inSegments &&
        this.expecting === "element"
      )
        this.startCapture("segment");
      else throw new Invalid();
    }
    this.capture!.push(c);
    if (c === '"') this.inString = true;
    else if (c === "{" || c === "[") this.depth += 1;
  }
}

export const streamTranscriptV1 = (
  file: string,
  options: { chunkBytes?: number } = {}
): StreamedV1 => {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { status: "missing" }
      : { status: "unreadable", error: String(error) };
  }
  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  const scanner = new V1Scanner();
  const buffer = Buffer.alloc(options.chunkBytes ?? 1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      const chunk = buffer.subarray(0, bytes);
      hash.update(chunk);
      scanner.feed(decoder.write(chunk));
    }
    scanner.feed(decoder.end());
  } catch (error) {
    if (error instanceof Invalid) return { status: "invalid" };
    return { status: "unreadable", error: String(error) };
  } finally {
    fs.closeSync(fd);
  }
  if (!scanner.done || !scanner.segmentsClosed || scanner.top.version !== 1)
    return { status: "invalid" };
  const updatedAt = scanner.top.updatedAt;
  return {
    status: "ok",
    ...(typeof updatedAt === "string" && { updatedAt }),
    segments: scanner.segments,
    fingerprint: hash.digest("base64url"),
  };
};
