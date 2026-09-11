/**
 * Download a pinned, checksummed third-party file into a package's `vendor/`.
 * Every binary the app ships but does not build (ripgrep, fd, the scrcpy
 * server jar) is fetched at build time and verified, because each one runs on
 * the user's machine or phone. A mismatched digest throws instead of writing.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** @param {Buffer | Uint8Array} buf */
export function digest(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** How many times a download is attempted before the build gives up. */
const ATTEMPTS = 4;
/** Backoff before each retry. Short: a build is waiting on this. */
const BACKOFF_MS = [500, 2_000, 5_000];

/**
 * 5xx is the host having a bad moment; 408 and 429 are it asking for a retry.
 * Other 4xx are answers, not hiccups: a 404 means the pin is wrong, and
 * retrying it turns a clear error into a slow one.
 *
 * @param {number} status
 */
const worthRetrying = (status) =>
  status >= 500 || status === 408 || status === 429;

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch `url` and return its bytes, checked against `sha256`; `label` names
 * the thing in messages. Transient failures are retried because no build can
 * proceed without the bytes. A checksum mismatch is not: asking again until
 * the digest matches is how a build accepts the wrong file.
 *
 * @param {string} url
 * @param {string} sha256
 * @param {string} label
 */
export async function fetchVerified(url, sha256, label) {
  let lastError;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const wait = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS.at(-1) ?? 5_000;

      console.warn(
        `[vendor] ${label}: ${lastError}; retrying in ${wait}ms (${attempt + 1}/${ATTEMPTS})`
      );
      await sleep(wait);
    }

    /** @type {Response} */
    let res;

    try {
      res = await fetch(url, { redirect: "follow" });
    } catch (err) {
      // No response at all: DNS, a reset connection, a proxy hanging up.
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }

    if (!res.ok) {
      lastError = `download failed with ${res.status} ${res.statusText}`;

      if (worthRetrying(res.status)) continue;

      throw new Error(`${label}: ${lastError}`);
    }

    /** @type {Buffer} */
    let body;

    try {
      body = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      // Status fine, body not: a truncated read is the same accident as never
      // connecting, and the digest would reject it with the wrong message.
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }

    const got = digest(body);

    if (got !== sha256) {
      throw new Error(
        `${label}: checksum mismatch\n  expected ${sha256}\n  got      ${got}`
      );
    }

    return body;
  }

  throw new Error(`${label}: ${lastError} (after ${ATTEMPTS} attempts)`);
}

/**
 * Write `body` to `dest`, creating its directory. `mode` is applied explicitly
 * because a CI cache or zip round trip loses the executable bit.
 *
 * @param {string} dest
 * @param {Buffer | Uint8Array} body
 * @param {number} [mode]
 */
export function writeVendored(dest, body, mode) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  if (mode != null) fs.chmodSync(dest, mode);
}

/**
 * Whether `dest` already holds exactly these bytes.
 * @param {string} dest
 * @param {string} sha256
 */
export function isCurrent(dest, sha256) {
  try {
    return digest(fs.readFileSync(dest)) === sha256;
  } catch {
    return false;
  }
}

/**
 * Fail the build with a one-line message rather than a stack nobody reads.
 * @param {string} label
 * @param {() => Promise<void>} main
 */
export function run(label, main) {
  main().catch((/** @type {Error} */ err) => {
    console.error(`[${label}] ${err.message}`);
    process.exit(1);
  });
}
