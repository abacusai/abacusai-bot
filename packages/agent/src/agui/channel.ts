/**
 * The compatibility channel (spec §2.4): negotiated synchronously before the
 * session exists, so an unusable fd 3 is known before either writer runs.
 *
 *   fd      compat lines go to fd 3 (preferred)
 *   inline  compat lines go to stdout, each behind one U+001E byte
 *   none    no compat (standalone / test use)
 *
 * After the handshake an asynchronous error on the fd-3 writer means main's
 * taps stopped hearing us; that is never silent (`onLost`).
 */
import * as nodeFs from "node:fs";
import * as net from "node:net";
import type { Writable } from "node:stream";

import type { CompatMode } from "./wire.js";

/** Prefix for an inline compat line. AG-UI lines always start with `{`. */
export const INLINE_COMPAT_PREFIX = "\u001e";

/** The minimal fs surface the preflight needs; injectable for tests. */
export interface PreflightFs {
  fstatSync(fd: number): unknown;
  writeSync(fd: number, data: string | Uint8Array): number;
}

const EAGAIN_BUDGET_MS = 1_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** writeSync, retrying EAGAIN (a non-blocking pipe that is momentarily full) for up to 1 s. */
function writeAllSync(fs: PreflightFs, fd: number, data: string): void {
  const deadline = Date.now() + EAGAIN_BUDGET_MS;
  let remaining = Buffer.from(data, "utf8");

  if (remaining.length === 0) {
    fs.writeSync(fd, "");

    return;
  }

  while (remaining.length > 0) {
    try {
      const written = fs.writeSync(fd, remaining);

      remaining = remaining.subarray(written);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "EAGAIN" &&
        Date.now() < deadline
      ) {
        sleepSync(10);
        continue;
      }

      throw error;
    }
  }
}

/**
 * Probe fd `compatFd` synchronously: fstat, a zero-byte write, then the
 * one-line `compat.hello` preamble main discards. Any throw means inline.
 */
export function preflightCompat(
  compatFd: number | undefined,
  incarnation: string,
  fs: PreflightFs = nodeFs
): CompatMode {
  if (compatFd == null) return "none";

  try {
    fs.fstatSync(compatFd);
    writeAllSync(fs, compatFd, "");
    writeAllSync(
      fs,
      compatFd,
      `${JSON.stringify({ type: "compat.hello", incarnation })}\n`
    );

    return "fd";
  } catch {
    return "inline";
  }
}

/** Writes compat lines; `write` takes one already-framed legacy line. */
export interface CompatWriter {
  readonly mode: CompatMode;
  write(line: string): void;
}

/** A writer for fd mode: a socket over the fd, or a write stream if that cannot be built. */
export function openFdWriter(
  compatFd: number,
  onLost: (error: Error) => void
): CompatWriter {
  let stream: Writable;

  try {
    stream = new net.Socket({ fd: compatFd, readable: false, writable: true });
  } catch {
    stream = nodeFs.createWriteStream("", { fd: compatFd });
  }

  return streamWriter(stream, onLost);
}

/** A writer over an arbitrary stream (fd mode, or an injected test stream). */
export function streamWriter(
  stream: Writable,
  onLost: (error: Error) => void
): CompatWriter {
  let lost = false;

  stream.on("error", (error: Error) => {
    if (lost) return;
    lost = true;
    onLost(error);
  });

  return {
    mode: "fd",
    write: (line) => {
      if (!lost) stream.write(line);
    },
  };
}

/** Inline mode: compat lines interleaved on stdout behind the RS byte. */
export function inlineWriter(writeStdout: (text: string) => void): CompatWriter {
  return {
    mode: "inline",
    write: (line) => writeStdout(`${INLINE_COMPAT_PREFIX}${line}`),
  };
}

export const noCompat: CompatWriter = { mode: "none", write: () => undefined };

/**
 * What main's read loop does with an agui runtime's stdout (exported so the
 * main-side router and the tests share one definition): an inline compat line
 * or an AG-UI line.
 */
export function classifyStdoutLine(
  line: string
): { kind: "compat"; line: string } | { kind: "agui"; line: string } {
  return line.startsWith(INLINE_COMPAT_PREFIX)
    ? { kind: "compat", line: line.slice(INLINE_COMPAT_PREFIX.length) }
    : { kind: "agui", line };
}
