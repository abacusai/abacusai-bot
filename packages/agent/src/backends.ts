/**
 * Where the agent's shell commands actually run. A backend overrides pi's
 * `BashOperations` (designed for exactly this), so pi's tool keeps its schema,
 * truncation, streaming and renderer; only the process spawn changes. Backends
 * beyond local and docker are declared but not implemented, so the selector
 * can show them with an honest reason.
 */
import { spawn } from "child_process";

import {
  createBashToolDefinition,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";

import { registerForegroundProcess } from "./background-processes.js";
import { currentMode } from "./current-mode.js";
import {
  backendName,
  decide,
  mentionedSecretPaths,
  resolvePolicy,
  sandboxEnforcement,
  type CredentialApprovals,
} from "./sandbox/index.js";
import {
  fallbackShell,
  loginEnvironment,
  mergePath,
  settleOnExit,
} from "./sandbox/shell.js";

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
 * `env` with `extra` merged into its PATH, under the key it already uses:
 * Windows spells it `Path`, and writing `PATH` beside it leaves two spellings
 * of which libuv keeps only one.
 */
function withMergedPath(
  env: NodeJS.ProcessEnv,
  extra: string | undefined
): NodeJS.ProcessEnv {
  const key = env.PATH == null && env.Path != null ? "Path" : "PATH";
  const merged = mergePath(env.PATH ?? env.Path, extra);

  return merged != null ? { ...env, [key]: merged } : { ...env };
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
            ? {
                env: {
                  ...(process.env.PATH != null
                    ? { PATH: process.env.PATH }
                    : {}),
                  ...options.env,
                },
              }
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
            /* docker unavailable — the client kill is all that is left */
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
        options.signal?.addEventListener("abort", onAbort, { once: true });

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
function localSandboxedOperations(
  approvals: CredentialApprovals | undefined
): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      const policy = resolvePolicy(
        currentMode(),
        cwd,
        approvals?.consume(command) ?? []
      );

      // The profile is sourced once, in `loginEnvironment` (sandbox/shell.ts);
      // inheriting this process's env would mean the launchd PATH.
      const shell = loginEnvironment();
      const childEnv =
        options.env != null
          ? withMergedPath(options.env, shell.PATH ?? shell.Path)
          : shell;

      // Built first: the sandbox binds back the PATH entries the CHILD will
      // use.
      const decision = decide(policy, command, cwd, childEnv);

      if (decision.kind === "refused") {
        options.onData(Buffer.from(`${decision.message}\n`));

        // 126, "found but not executable": the closest standard code to
        // refused.
        return { exitCode: 126 };
      }

      const fallback = fallbackShell(command);
      const argv =
        decision.kind === "confined"
          ? decision.argv
          : [fallback.file, ...fallback.args];

      return new Promise((resolve) => {
        const child = spawn(argv[0]!, argv.slice(1), {
          cwd,
          // Its own process group, so a deadline takes down what the command
          // started too; a leftover subshell is what keeps the output pipes
          // open.
          detached: process.platform !== "win32",
          env: childEnv,
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
              /* group already reaped — fall through to the direct kill */
            }
          }
          child.kill("SIGKILL");
        };

        // Shutdown must take the process group with it, as a deadline would.
        const unregister = registerForegroundProcess({ kill: terminate });

        const onAbort = (): void => {
          terminate();
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });

        const timer = deadline(options.timeout, terminate);

        // The tail of the output, to name a hidden store on failure.
        let tail = "";
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
          if (code !== 0 && decision.kind === "confined") {
            const note = hiddenStoreNote(tail, policy.secrets.promptable);
            if (note != null) options.onData(Buffer.from(note));
          }
          resolve({ exitCode: code ?? 1 });
        });
      });
    },
  };
}

const OUTPUT_TAIL_CHARS = 16_384;

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

/**
 * Operations for the selected backend, or null to use pi's own local shell,
 * which handles shell resolution and platform differences better than a
 * reimplementation would; `off` returns null for the same reason.
 */
export function backendOperations(
  /** The session's credential approvals; absent for a caller with no card. */
  approvals?: CredentialApprovals
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

    return dockerOperations(
      (process.env.ABACUSAI_BOT_DOCKER_IMAGE ?? "").trim() ||
        "debian:bookworm-slim"
    );
  }

  // A container is already a boundary; the host sandbox knows none of its
  // paths.
  if (backend !== "local") return null;

  if (sandboxEnforcement() === "off") return null;

  // Windows has no backend and no /bin/bash, so under `auto` null lets pi's
  // local path run; `strict` keeps the operations so its refusal reaches the
  // model.
  if (backendName() === null && sandboxEnforcement() !== "strict") return null;

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
