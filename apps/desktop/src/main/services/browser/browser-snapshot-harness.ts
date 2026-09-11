/**
 * The test-side half of the snapshot harness: spawns Electron once per suite
 * with every fixture and returns what the walker made of each. See
 * browser-snapshot-electron-entry.mjs for why it needs a real browser.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";

const HARNESS = path.join(
  import.meta.dirname,
  "browser-snapshot-electron-entry.mjs"
);

import type { SnapshotNode } from "./browser-snapshot";

export type { SnapshotNode };

export interface SnapshotResult {
  title: string;
  url: string;
  tree: SnapshotNode | null;
  refCount: number;
  visibleCount: number;
  offscreenCount: number;
}

/** How the walker can be run here, if at all. */
export interface HarnessAvailability {
  usable: boolean;
  /** Set when it cannot run; a reason fit to put in a skip message. */
  reason?: string;
  /** Wrapper for the Electron call, e.g. xvfb-run on headless Linux. */
  wrapper?: { command: string; args: string[] };
}

const canRun = (command: string): boolean => {
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });

    return true;
  } catch {
    return false;
  }
};

function displayFor(): HarnessAvailability {
  // Windows and macOS lay out a hidden window without any display server.
  if (process.platform !== "linux") return { usable: true };

  if ((process.env.DISPLAY ?? "").length > 0) return { usable: true };

  // GitHub's Linux runners ship Xvfb; `-a` picks a free display number.
  if (canRun("xvfb-run"))
    return { usable: true, wrapper: { command: "xvfb-run", args: ["-a"] } };

  return {
    usable: false,
    reason:
      "needs a browser with real layout: no DISPLAY and no xvfb-run on this Linux host",
  };
}

/**
 * Asymmetric on purpose: macOS and Windows lay out a hidden window with no
 * display server, so there a failure to start is a failure. Linux needs an X
 * server and system libraries a host may lack, so it is probed with one
 * trivial page and skipped with a reason rather than turning a run red.
 */
export function harnessAvailability(): HarnessAvailability {
  const display = displayFor();

  if (!display.usable || process.platform !== "linux") return display;

  try {
    runSnapshotFixtures("1", { probe: "<!doctype html><body></body>" });

    return display;
  } catch (error) {
    return {
      usable: false,
      reason: `this Linux host cannot run Electron for the walker: ${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      }`,
    };
  }
}

/**
 * Run `script` against each fixture and return the results by name. Throws
 * rather than returning partial results, so a half-working harness is one
 * clear message instead of scattered assertion failures.
 */
export function runSnapshotFixtures(
  script: string,
  fixtures: Record<string, string>
): Record<string, SnapshotResult> {
  const availability = displayFor();

  if (!availability.usable)
    throw new Error(
      availability.reason ?? "the snapshot harness cannot run here"
    );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-harness-"));
  const inputFile = path.join(dir, "input.json");

  fs.writeFileSync(inputFile, JSON.stringify({ script, fixtures }));

  try {
    // The electron package's main export is the binary path, and it is
    // CommonJS.
    const electron = createRequire(import.meta.url)("electron") as string;
    const electronArgs = [
      HARNESS,
      inputFile,
      // No GPU on runners, and the sandbox needs kernel features CI may not
      // grant. Neither affects layout.
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
    ];
    const command = availability.wrapper?.command ?? electron;
    const args =
      availability.wrapper != null
        ? [...availability.wrapper.args, electron, ...electronArgs]
        : electronArgs;

    let stdout = "";
    try {
      stdout = execFileSync(command, args, {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
          ELECTRON_ENABLE_LOGGING: "",
        },
      });
    } catch (error) {
      // A fixture failure exits non-zero but still leaves the result file.
      const detail = error instanceof Error ? error.message : String(error);
      if (!fs.existsSync(`${inputFile}.out.json`))
        throw new Error(`the harness would not run: ${detail}`);
    }

    const outputFile = `${inputFile}.out.json`;

    if (!fs.existsSync(outputFile)) {
      throw new Error(
        `the harness wrote no result. Output was:\n${stdout.slice(0, 2000)}`
      );
    }

    const payload = JSON.parse(fs.readFileSync(outputFile, "utf8")) as {
      error?: string;
      results?: Record<
        string,
        { ok: boolean; value?: SnapshotResult; error?: string }
      >;
    };

    if (payload.error != null)
      throw new Error(`the harness failed: ${payload.error}`);

    const out: Record<string, SnapshotResult> = {};

    for (const [name, result] of Object.entries(payload.results ?? {})) {
      if (!result.ok)
        throw new Error(`fixture "${name}" threw in the page: ${result.error}`);
      out[name] = result.value!;
    }

    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Every node in a tree, depth first, so a test can search by name or tag. */
export function flatten(node: SnapshotNode | null | undefined): SnapshotNode[] {
  if (node == null) return [];

  return [node, ...(node.children ?? []).flatMap(flatten)];
}

/** The node whose label is exactly `name`. */
export function byName(
  tree: SnapshotNode | null,
  name: string
): SnapshotNode | undefined {
  return flatten(tree).find((node) => node.name === name);
}
