#!/usr/bin/env node

/**
 * Fetch the wa-js build the WhatsApp connector injects into WhatsApp Web.
 *
 * Third-party, Apache-2.0 (wppconnect-team/wa-js), so it is fetched at build
 * time rather than committed. The version is pinned and the
 * download hash-checked: this file runs inside the user's WhatsApp session,
 * and a build that floats is a build nobody has read.
 *
 * Bumping it is the fix path when WhatsApp Web changes underneath: the
 * connector logs "bridge did not attach" and falls back to the page driver
 * until this pin moves to a release that knows the new modules.
 *
 * Idempotent — a correct file already on disk is left alone.
 *
 * Usage:
 *   node scripts/download-wa-js.js
 */

import path from "node:path";

import {
  fetchVerified,
  isCurrent,
  run,
  writeVendored,
} from "@abacus-ai/config/vendor-fetch";

const VERSION = "4.6.0";
const SHA256 =
  "5bfb88027f14a4d8c9e319374e8bb4083201906881cf8c74f75789b32e4106bd";
const URL = `https://github.com/wppconnect-team/wa-js/releases/download/v${VERSION}/wppconnect-wa.js`;

const ROOT = path.resolve(import.meta.dirname, "..");
// Beside the scrcpy server: resources/vendor/ ships verbatim, so this is
// already the packaged path (see resourcePath in main/resources.ts).
const DEST = path.join(ROOT, "resources", "vendor", "wppconnect-wa.js");

async function main() {
  if (isCurrent(DEST, SHA256)) {
    console.log(`[wa-js] v${VERSION} already present`);
    return;
  }

  console.log(`[wa-js] downloading v${VERSION}`);
  const body = await fetchVerified(URL, SHA256, `wppconnect-wa.js v${VERSION}`);
  writeVendored(DEST, body);
  console.log(
    `[wa-js] wrote ${path.relative(ROOT, DEST)} (${body.length} bytes)`
  );
}

run("wa-js", main);
