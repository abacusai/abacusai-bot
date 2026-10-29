import { spawn } from "child_process";
/**
 * Where the agent's shell commands actually run. A backend overrides pi's
 * `BashOperations` (designed for exactly this), so pi's tool keeps its schema,
 * truncation, streaming and renderer; only the process spawn changes. Backends
 * beyond local and docker are declared but not implemented, so the selector
 * can show them with an honest reason.
 */
import * as fs from "node:fs";

import {
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";

import { registerForegroundProcess } from "./background-processes.js";
import { childProcessEnv } from "./child-env.js";
import { currentMode } from "./current-mode.js";
import { modelPath } from "./model-path.js";
import {
  commandPosixShell,
  managedPythonEnv,
  posixShellEnv,
  posixShellOperations,
} from "./posix-shell.js";
import {
  allowHostForSession,
  allowHostOnce,
  backendPresent,
  decide,
  mentionedSecretPaths,
  networkConfinable,
  resolvePolicy,
  sandboxEnforcement,
  settledDenials,
  violations,
  type Denial,
  type SandboxApprovals,
} from "./sandbox/index.js";
import { classifyCommand } from "./sandbox/intent.js";
import {
  fallbackShell,
  loginEnvironment,
  mergePath,
  settleOnExit,
} from "./sandbox/shell.js";
import { zoneContext } from "./sandbox/zones.js";
import { trashShimEnv, withTrashGuard, type TrashScope } from "./trash.js";

export type BackendId =
  | "local"
  | "docker"
  | "singularity"
  | "modal"
  | "daytona"
  | "ssh";

/** Backend chosen for this session, from the desktop. Local when unset. */
export function selectedBackend(): BackendId {
  const raw = (process.env.ABACUSAI_BOT_EXEC_BACKEND ?? "local")
    .trim()
    .toLowerCase();
  const known: BackendId[] = [
    "local",
    "docker",
    "singularity",
    "modal",
    "daytona",
    "ssh",
  ];

  return (known as string[]).includes(raw) ? (raw as BackendId) : "local";
}

/**
 * The deadline for one command, as a timer, or null. `BashOperations.exec`
 * receives `timeout` in SECONDS; passed raw to `setTimeout` the stamped 120s
 * becomes 120ms and every command is SIGKILLed before its first byte.
 */
export function deadline(
  seconds: number | undefined,
  onExpiry: () => void
): NodeJS.Timeout | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;

  return setTimeout(onExpiry, seconds * 1_000);
}

/**
 * Run commands inside a Docker container with the workspace bind-mounted at its
 * host path, so paths the model learned from `read` or `grep` stay valid in a
 * shell command. `--rm` per command: nothing to poison the next one or leak.
 */
let containerCounter = 0;

function dockerOperations(image: string): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      // Named so it can be stopped by name: killing the `docker run` client
      // only
      // detaches, leaving the command running with nobody reading it.
      const containerName = `abacusai-bot-${process.pid}-${++containerCounter}`;

      const args = [
        "run",
        "--rm",
        "-i",
        "--name",
        containerName,
        "--workdir",
        cwd,
        "--volume",
        `${cwd}:${cwd}`,
        image,
        "bash",
        "-lc",
        command,
      ];

      return new Promise((resolve) => {
        const child = spawn(
          "docker",
          args,
          options.env != null
            ? { env: childProcessEnv({ PATH: process.env.PATH }, options.env) }
            : {}
        );

        // `-i` holds stdin open; a command that reads it would hang until
        // timeout.
        child.stdin.end();

        const killContainer = (): void => {
          // Failures ignored: the container has usually already exited.
          try {
            spawn("docker", ["kill", containerName], { stdio: "ignore" }).on(
              "error",
              () => {}
            );
          } catch {
            /* docker unavailable: the client kill is all that is left */
          }
        };

        const terminate = (): void => {
          // Container first, then the client; `--rm` cleans up once it is dead.
          killContainer();
          child.kill("SIGKILL");
        };

        // Shutdown must reach the container, not just the client.
        const unregister = registerForegroundProcess({
          kill: () => child.kill("SIGKILL"),
          spawnCleanup: killContainer,
        });

        const onAbort = (): void => {
          terminate();
        };
        // The decision above is asynchronous; an abort that landed meanwhile
        // must still take the command down.
        if (options.signal?.aborted === true) terminate();
        else options.signal?.addEventListener("abort", onAbort, { once: true });

        const timer = deadline(options.timeout, terminate);

        child.stdout.on("data", (data: Buffer) => options.onData(data));
        child.stderr.on("data", (data: Buffer) => options.onData(data));

        child.on("error", (error) => {
          // As output, not thrown: the model should see it and adapt.
          options.onData(
            Buffer.from(`Failed to run command in Docker: ${error.message}\n`)
          );
          if (timer != null) clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          unregister();
          resolve({ exitCode: 127 });
        });

        settleOnExit(child, (code) => {
          if (timer != null) clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          unregister();
          // code is null when our kill signalled the client; report a real
          // code.
          resolve({ exitCode: code ?? 1 });
        });
      });
    },
  };
}

/**
 * Run commands on this machine, confined by the OS where it can be. Exists
 * only because pi's local path has no seam for wrapping the argv. A refusal is
 * output plus a non-zero exit, not a throw, so the model reads why and adapts.
 */
/**
 * Run commands on this machine, confined by the OS. Exists only because pi's
 * local path has no seam for wrapping the argv. A refusal is output plus a
 * non-zero exit, not a throw, so the model reads why and adapts. When the
 * sandbox refused something and a card can be shown, the user is asked and
 * the command runs once more with what they allowed.
 */
function localSandboxedOperations(
  approvals: SandboxApprovals | undefined
): BashOperations {
  const attempt = async (
    command: string,
    cwd: string,
    options: Parameters<BashOperations["exec"]>[2],
    retried: boolean
  ): Promise<{ exitCode: number }> => {
    const mode = currentMode();
    // What the command's own text says it will do outside the workspace: a
    // benign line (a new file on the Desktop) is granted for this run, the
    // rest is left to the kernel and the card (sandbox/intent.ts).
    const intent =
      sandboxEnforcement(mode) === "off"
        ? null
        : classifyCommand(command, cwd, {
            context: zoneContext(cwd),
            ledger: approvals?.created,
          });
    const policy = resolvePolicy(mode, cwd, {
      approvedReads: approvals?.reads.consume(command) ?? [],
      approvedWrites: [
        ...(approvals?.writes.consume(command) ?? []),
        ...(intent?.grants ?? []),
      ],
      filteredNetwork: networkConfinable(),
    });

    // The profile is sourced once, in `loginEnvironment` (sandbox/shell.ts);
    // inheriting this process's env would mean the launchd PATH.
    const shell = loginEnvironment();
    const inherited = childProcessEnv(options.env ?? shell);
    const merged =
      options.env != null ? mergePath(inherited.PATH, shell.PATH) : undefined;
    const childEnv = childProcessEnv(
      inherited,
      merged != null ? { PATH: merged } : undefined,
      // Node's own fetch ignores the proxy variables unless told; without this
      // a Node tool's request goes direct, is refused, and no card can be raised.
      policy.network.kind === "filtered"
        ? { NODE_USE_ENV_PROXY: "1" }
        : undefined
    );

    const commandId = `command-${++commandCounter}`;
    // On Windows the command runs under the bundled POSIX shell, confined or
    // not, and its children must find the applets (posix-shell.ts). Taken per
    // command, so one removed since the last is reinstalled first.
    const bundledShell =
      process.platform === "win32" ? commandPosixShell() : undefined;
    // What a delete may send to the trash: what the sandbox lets it write,
    // until the decision says the command runs unconfined (trash.ts).
    const trash: TrashScope = {
      roots:
        policy.enforcement === "off"
          ? null
          : [
              ...(policy.mode === "workspace-write"
                ? [policy.workspaceRoot, ...policy.toolHomes]
                : []),
              ...policy.writableTemp,
              ...policy.approvedWrites,
            ],
    };
    const spawnEnv = trashShimEnv(
      bundledShell != null ? posixShellEnv(childEnv, bundledShell) : childEnv,
      trash
    );
    const decision = await decide(policy, command, cwd, spawnEnv, commandId);
    if (decision.kind === "unconfined") trash.roots = null;

    if (decision.kind === "refused") {
      options.onData(Buffer.from(`${decision.message}\n`));

      // 126, "found but not executable": the closest standard code to
      // refused.
      return { exitCode: 126 };
    }

    const fallback = fallbackShell(
      command,
      process.platform,
      process.env,
      bundledShell ?? null
    );
    const argv =
      decision.kind === "confined"
        ? decision.argv
        : [fallback.file, ...fallback.args];

    // The tail of the output, to name a hidden store on failure.
    let tail = "";
    const result = await new Promise<{ exitCode: number }>((resolve) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        // Its own process group, so a deadline takes down what the command
        // started too; a leftover subshell is what keeps the output pipes
        // open.
        detached: process.platform !== "win32",
        env: spawnEnv,
        // Written for the platform's shell; must not be re-quoted
        // (sandbox/shell.ts).
        ...(decision.kind !== "confined" &&
        fallback.windowsVerbatimArguments === true
          ? { windowsVerbatimArguments: true }
          : {}),
      });

      // A command that reads stdin would otherwise hang until the timeout.
      child.stdin.end();

      const terminate = (): void => {
        // Negative pid is the whole group; it fails only when already gone.
        if (child.pid != null && process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
            /* group already reaped, fall through to the direct kill */
          }
        }
        child.kill("SIGKILL");
      };

      // Shutdown must take the process group with it, as a deadline would.
      const unregister = registerForegroundProcess({ kill: terminate });

      const onAbort = (): void => {
        terminate();
      };
      // The decision above is asynchronous; an abort that landed meanwhile
      // must still take the command down.
      if (options.signal?.aborted === true) terminate();
      else options.signal?.addEventListener("abort", onAbort, { once: true });

      const timer = deadline(options.timeout, terminate);

      const collect = (data: Buffer): void => {
        options.onData(data);
        tail = (tail + data.toString()).slice(-OUTPUT_TAIL_CHARS);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      child.on("error", (error) => {
        options.onData(
          Buffer.from(`Failed to run command: ${error.message}\n`)
        );
        if (timer != null) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        unregister();
        resolve({ exitCode: 127 });
      });

      settleOnExit(child, (code) => {
        if (timer != null) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        unregister();
        resolve({ exitCode: code ?? 1 });
      });
    });

    // The runtime hears a refusal a beat after the exit; wait for it, then
    // tell the model. Whatever the exit code: `rm x; echo done` exits 0 with
    // the rm refused, and a model that never hears of the refusal guesses at
    // the cause. The runtime's own account first, then the way to a prompt
    // for a hidden store.
    const refused =
      decision.kind === "confined"
        ? await settledDenials(commandId, { exitCode: result.exitCode, tail })
        : [];
    if (decision.kind === "confined") {
      const denied = violations(commandId);
      if (denied != null) options.onData(Buffer.from(`\n${denied}\n`));
      const note = hiddenStoreNote(tail, policy.secrets.promptable);
      if (note != null) options.onData(Buffer.from(note));
    }

    // What a granted command made is the session's own from here on.
    if (decision.kind === "confined" && approvals != null && intent != null) {
      for (const made of intent.creates)
        if (fs.existsSync(made)) approvals.created.add(made);
    }

    if (
      decision.kind !== "confined" ||
      retried ||
      approvals?.askDenials == null
    )
      return result;

    // The sandbox refused something, whether or not the command's last step
    // then succeeded: ask, and run once more with the answer.
    if (refused.length === 0) return result;
    const answer = await approvals.askDenials(
      command,
      refused,
      intent != null && intent.concerns.length > 0
        ? `The command ${intent.concerns.join("; ")}.`
        : null
    );
    if (answer == null) return result;

    approvals.apply(command, answer);
    for (const denial of answer.once)
      if (denial.kind === "host") allowHostOnce(denial.host);
    for (const denial of answer.session)
      if (denial.kind === "host") allowHostForSession(denial.host);
    options.onData(
      Buffer.from(
        `\n[sandbox] The user allowed ${describeDenials(answer.once, answer.session)}; running the command again.\n`
      )
    );

    return attempt(command, cwd, options, true);
  };

  return {
    exec: (command, cwd, options) => attempt(command, cwd, options, false),
  };
}

/** `write /a, read /b, host x:443`, once each, for the note between the runs. */
export function describeDenials(
  ...lists: readonly (readonly Denial[])[]
): string {
  const seen = new Set<string>();

  return lists
    .flat()
    .map((denial) =>
      denial.kind === "host"
        ? `${denial.kind} ${denial.host}:${denial.port}`
        : `${denial.kind} ${modelPath(denial.path)}`
    )
    .filter((text) => !seen.has(text) && seen.add(text) !== undefined)
    .join(", ");
}

const OUTPUT_TAIL_CHARS = 16_384;

let commandCounter = 0;

/**
 * What a failed command is told when its output names a hidden store. The
 * prompt is raised by naming the path, so the model is pointed at that rather
 * than at a workaround.
 */
export function hiddenStoreNote(
  output: string,
  promptable: readonly string[]
): string | null {
  const mentioned = mentionedSecretPaths(output, promptable);
  if (mentioned.length === 0) return null;

  return (
    `\n[sandbox] ${mentioned.join(", ")} is a credential store the sandbox ` +
    `hides. If the user should allow reading it, run the command again with ` +
    `that path written out so they can approve it on the prompt. Do not work ` +
    `around the sandbox.\n`
  );
}

/** A command that runs python or pip, as a command word rather than a path. */
const RUNS_PYTHON = /(?:^|[\s;&|(`])(?:python3?|pip3?)(?=$|[\s;&|)`])/;

/** How this process asks the desktop to set up the app's Python. */
let pythonProvisioner: (() => Promise<unknown>) | null = null;
/** That setup, shared by every command; cleared on failure so a later one retries. */
let pythonReady: Promise<unknown> | null = null;

/** Registered by the session that owns the host channel; null where there is none. */
export function setPythonProvisioner(
  provision: (() => Promise<unknown>) | null
): void {
  pythonProvisioner = provision;
  pythonReady = null;
}

/** First-time setup downloads Python and packages; a slow line needs minutes. */
export const PYTHON_SETUP_TIMEOUT_MS = 15 * 60_000;

/** Only when setup outlasts this does the command say it is waiting. */
const PYTHON_NOTICE_MS = 1_000;

/**
 * Commands that run python or pip wait for the app's own Python first, and
 * say so in their output while it is set up; every other command runs as is.
 */
export function withManagedPython(operations: BashOperations): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      const provision = pythonProvisioner;
      if (provision != null && RUNS_PYTHON.test(command)) {
        const ready = (pythonReady ??= provision());
        ready.catch(() => {
          if (pythonReady === ready) pythonReady = null;
        });
        const say = (line: string): void =>
          options.onData(Buffer.from(`[python] ${line}\n`));
        const started = Date.now();
        let noticed = false;
        const notice = setTimeout(() => {
          noticed = true;
          say(
            "Setting up Python for the first time; this can take a minute or two."
          );
        }, PYTHON_NOTICE_MS);
        // A stopped command stops waiting; the setup itself carries on.
        let onAbort: (() => void) | undefined;
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error("aborted"));
          if (options.signal?.aborted) onAbort();
          else
            options.signal?.addEventListener("abort", onAbort, { once: true });
        });
        try {
          await Promise.race([ready, aborted]);
          if (noticed)
            say(
              `Python is ready (${Math.round((Date.now() - started) / 1000)}s).`
            );
        } catch (error) {
          if (options.signal?.aborted) throw error;
          // The command still runs: its own failure says the rest.
          say(error instanceof Error ? error.message : String(error));
        } finally {
          clearTimeout(notice);
          if (onAbort != null)
            options.signal?.removeEventListener("abort", onAbort);
        }
      }

      return operations.exec(command, cwd, options);
    },
  };
}

/**
 * Operations for the selected backend, or null to use pi's own local shell,
 * which handles shell resolution and platform differences better than a
 * reimplementation would; ABACUSAI_BOT_SANDBOX=off returns null for the same
 * reason. Full access is per command (decide), since the mode can change
 * mid-session.
 */
export function backendOperations(
  /** The session's sandbox approvals; absent for a caller with no card. */
  approvals?: SandboxApprovals
): BashOperations | null {
  const backend = selectedBackend();

  if (backend === "docker") {
    // A `C:\` host path can never be a workdir in a Linux guest; fail once at
    // selection rather than on every command with a mount error.
    if (process.platform === "win32") {
      throw new Error(
        "The Docker backend needs a POSIX host path to mirror into the container; on Windows use the local backend."
      );
    }

    return withTrashGuard(
      dockerOperations(
        (process.env.ABACUSAI_BOT_DOCKER_IMAGE ?? "").trim() ||
          "debian:bookworm-slim"
      )
    );
  }

  // A container is already a boundary; the host sandbox knows none of its
  // paths.
  if (backend !== "local") return null;

  const local = localOperations(approvals);
  if (managedPythonEnv() == null)
    return local == null ? null : withTrashGuard(local);

  return withTrashGuard(
    withManagedPython(local ?? createLocalBashOperations())
  );
}

/**
 * The shell a tool runs commands through: this backend's, or pi's own local
 * one where that is right, both refusing to empty the trash (trash.ts).
 */
export function agentShellOperations(
  approvals?: SandboxApprovals
): BashOperations {
  return (
    backendOperations(approvals) ?? withTrashGuard(createLocalBashOperations())
  );
}

/** The local backend's operations, or null for pi's own shell. */
function localOperations(approvals?: SandboxApprovals): BashOperations | null {
  // No kernel backend, or none that can run here (a Windows without the
  // vendored runner): the shell there is the bundled POSIX one, sandbox
  // setting or not: it is a shell, not a confinement, and null without its
  // payload lets pi's own path run. `strict` keeps the operations so its
  // refusal reaches the model.
  if (!backendPresent()) {
    return sandboxEnforcement() === "strict"
      ? localSandboxedOperations(approvals)
      : posixShellOperations();
  }

  // Switched off by the environment: pi's own path, under the bundled shell
  // where that is the shell there is.
  if (sandboxEnforcement() === "off")
    return process.platform === "win32" ? posixShellOperations() : null;

  return localSandboxedOperations(approvals);
}

/**
 * pi's bash tool rebuilt to run through this backend, or null when pi's own is
 * right. Every session that gives a model a shell must call this, sub-agents
 * included, and add `'bash'` to `excludeTools` when it returns a tool, or the
 * unconfined built-in stays available. No `background` option: a sub-agent
 * loads only guardrails, so it could neither hear about nor read the job.
 */
export function confinedBashTool(
  cwd: string
): ReturnType<typeof createBashToolDefinition> | null {
  const operations = backendOperations();

  return operations == null
    ? null
    : createBashToolDefinition(cwd, { operations });
}

/**
 * Run one command through this backend, shaped like pi's `exec` result, or null
 * when there is no backend. For extensions that run project commands: the
 * model can write `package.json`, so an approvable edit would otherwise become
 * unconfined execution the moment the verify loop runs the tests.
 */
export async function execConfined(
  command: string,
  cwd: string,
  options: { timeout?: number; signal?: AbortSignal } = {}
): Promise<{
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
} | null> {
  const operations = backendOperations();
  if (operations == null) return null;

  // The backends stream both through one callback, so stderr stays empty;
  // every caller concatenates the two anyway.
  let output = "";
  const { exitCode } = await operations.exec(command, cwd, {
    onData: (data: Buffer) => {
      output += data.toString();
    },
    ...(options.signal != null ? { signal: options.signal } : {}),
    ...(options.timeout != null ? { timeout: options.timeout } : {}),
  });

  return { stdout: output, stderr: "", code: exitCode ?? 1, killed: false };
}
