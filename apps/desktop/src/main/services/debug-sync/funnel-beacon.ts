/**
 * Reports first-run milestones (shared/funnel.ts) so setup drop-off can be
 * counted per install, including before sign-in, when no other upload runs.
 *
 * One GET per milestone carrying the step, a short detail code, the install id
 * the log sync files logs under (so a later sign-in ties them to the account),
 * and the app version and platform. No content, account or key. The path is
 * not an API method: the server answers 404 and only the request is recorded.
 * Off when the diagnostics toggle is.
 */
import fs from "fs";
import path from "path";

import { app } from "electron";

import { funnelDetail, type FunnelStep } from "#shared/funnel";

import { abacusBotHome } from "../../paths";
import { readSettings } from "../config/settings";
import { abacusAppHost, abacusUserAgent } from "../providers/abacus-host";
import { deviceId } from "./device-id";

const BEACON_PATH = "/api/v1/_abacusaibotFunnelStep";
const TIMEOUT_MS = 10_000;

/** Steps that count once per install, recorded beside the device id. */
const onceFile = (): string => path.join(abacusBotHome(), "funnel-once.json");

const enabled = (): boolean => {
  try {
    return readSettings().serverDebugSync ?? true;
  } catch {
    // Unreadable settings: report, as the log sync would.
    return true;
  }
};

const appFacts = (): { version: string; build: string } => {
  try {
    return {
      version: app.getVersion(),
      build: app.isPackaged ? "packaged" : "source",
    };
  } catch {
    // No `app` outside electron (tests).
    return { version: "unknown", build: "source" };
  }
};

export function reportFunnelStep(step: FunnelStep, detail?: string): void {
  const code = funnelDetail(detail);
  // Also in the main log, which syncs with the account after sign-in.
  console.log(`[funnel] ${step}${code ? ` ${code}` : ""}`);
  if (!enabled()) return;

  const { version, build } = appFacts();
  const url = new URL(BEACON_PATH, abacusAppHost());
  url.searchParams.set("step", step);
  if (code) url.searchParams.set("detail", code);
  url.searchParams.set("install", deviceId());
  url.searchParams.set("v", version);
  url.searchParams.set("os", process.platform);
  url.searchParams.set("arch", process.arch);
  url.searchParams.set("build", build);

  void fetch(url, {
    headers: { "user-agent": abacusUserAgent() },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {
    // Offline or blocked: a lost milestone is not worth a retry queue.
  });
}

/** Read once per run; after that a repeat costs a lookup, not a file read. */
let seenOnce: Record<string, true> | null = null;

/** Tests only: forget what this run has reported. */
export function resetFunnelOnceForTests(): void {
  seenOnce = null;
}

/** Report `step` the first time this install reaches it, and never again. */
export function reportFunnelStepOnce(step: FunnelStep, detail?: string): void {
  if (seenOnce == null) {
    try {
      seenOnce = JSON.parse(fs.readFileSync(onceFile(), "utf-8")) as Record<
        string,
        true
      >;
    } catch {
      // First milestone of this install.
      seenOnce = {};
    }
  }
  const seen = seenOnce;
  if (seen[step] === true) return;
  seen[step] = true;
  try {
    fs.mkdirSync(path.dirname(onceFile()), { recursive: true });
    fs.writeFileSync(onceFile(), JSON.stringify(seen), "utf-8");
  } catch {
    // Unwritable home: it may report again next time, which is harmless.
  }
  reportFunnelStep(step, detail);
}
