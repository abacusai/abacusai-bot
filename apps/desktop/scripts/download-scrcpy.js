#!/usr/bin/env node

/**
 * Fetch the scrcpy server jar the Android mirror pushes to the device.
 *
 * It is a third-party Apache-2.0 binary (Genymobile/scrcpy), so it is fetched
 * at build time rather than committed. The version is NOT free to float: the
 * client in android-scrcpy-service.ts announces itself as SCRCPY_VERSION and
 * the server aborts on a mismatch, so this pins the exact release that
 * protocol was written against.
 *
 * Idempotent — a correct jar already on disk is left alone, so `dev` and
 * `build` can both depend on it without paying for a download every time.
 *
 * Usage:
 *   node scripts/download-scrcpy.js
 */

import path from "node:path";

import {
  fetchVerified,
  isCurrent,
  run,
  writeVendored,
} from "@abacus-ai/config/vendor-fetch";

const VERSION = "2.7";
const SHA256 =
  "a23c5659f36c260f105c022d27bcb3eafffa26070e7baa9eda66d01377a1adba";
const URL = `https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}`;

const ROOT = path.resolve(import.meta.dirname, "..");
// Downloaded third-party files go in `vendor/`, and this app's resources
// directory ships verbatim — so this is already the packaged path. It used to
// land in src/main/native/, which put a downloaded artifact inside the source
// tree and made "is this checked in?" a question anyone had to ask.
const DEST = path.join(ROOT, "resources", "vendor", "scrcpy-server.jar");

async function main() {
  if (isCurrent(DEST, SHA256)) {
    console.log(`[scrcpy] server v${VERSION} already present`);
    return;
  }

  console.log(`[scrcpy] downloading server v${VERSION}`);
  const body = await fetchVerified(URL, SHA256, `scrcpy-server-v${VERSION}`);
  writeVendored(DEST, body);
  console.log(
    `[scrcpy] wrote ${path.relative(ROOT, DEST)} (${body.length} bytes)`
  );
}

run("scrcpy", main);
