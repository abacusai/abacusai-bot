/**
 * macOS and Linux confinement through Anthropic's sandbox runtime: Seatbelt
 * or bubblewrap for files, and its loopback HTTP and SOCKS proxies for the
 * network, which hold a host nobody listed while the user is asked. This
 * module maps a SandboxPolicy onto the runtime's config and keeps the one
 * per-process instance, since a sub-agent shares the policy but has no card
 * of its own.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

import type { Denial } from "./approvals.js";
import type { SandboxPolicy } from "./policy.js";
import { probeVerdict, type ProbeExec } from "./probe.js";
import { POSIX_SHELL } from "./shell.js";

/** Hosts a coding task reaches without asking: registries and code hosts. */
export const DEFAULT_HOSTS: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "::1",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "*.githubusercontent.com",
  "gitlab.com",
  "bitbucket.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "rubygems.org",
  "index.rubygems.org",
  "repo.maven.apache.org",
  "plugins.gradle.org",
  "services.gradle.org",
  "packagist.org",
  "repo.packagist.org",
  "api.nuget.org",
  "deb.debian.org",
  "security.debian.org",
  "archive.ubuntu.com",
  "security.ubuntu.com",
  "dl-cdn.alpinelinux.org",
  "huggingface.co",
  "*.huggingface.co",
  "ghcr.io",
  "registry-1.docker.io",
  "auth.docker.io",
  "production.cloudflare.docker.com",
];

/** Hosts the environment pre-approves, comma-separated. */
export function configuredHosts(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return (env.ABACUSAI_BOT_SANDBOX_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Unix sockets a command may still reach: the ssh and gpg agents, so
 * `git push` and signed commits work with the keys hidden. Everything else
 * (the session bus, Docker) stays closed.
 */
export function agentSockets(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  exists: (candidate: string) => boolean = fs.existsSync
): string[] {
  const candidates = [
    env.SSH_AUTH_SOCK,
    path.join(home, ".gnupg"),
    env.XDG_RUNTIME_DIR != null
      ? path.join(env.XDG_RUNTIME_DIR, "gnupg")
      : undefined,
  ];

  return candidates.filter(
    (candidate): candidate is string =>
      candidate != null && candidate.length > 0 && exists(candidate)
  );
}

/**
 * Never resolved through PATH: a project-relative bin directory is an
 * ordinary developer setup, and a planted `bwrap` would satisfy the probe
 * and confine nothing. Undefined lets the runtime report the binary missing.
 */
function fixedBinary(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);

      return candidate;
    } catch {
      // Try the next one.
    }
  }

  return undefined;
}

const BWRAP_CANDIDATES = [
  "/usr/bin/bwrap",
  "/bin/bwrap",
  "/usr/local/bin/bwrap",
];
const SOCAT_CANDIDATES = [
  "/usr/bin/socat",
  "/bin/socat",
  "/usr/local/bin/socat",
];

/** The per-process config; per-command paths come in through `commandConfig`. */
export function baseConfig(
  hosts: readonly string[],
  sockets: readonly string[]
): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains: [...hosts],
      deniedDomains: [],
      // A dev server the command starts must still answer.
      allowLocalBinding: true,
      allowUnixSockets: [...sockets],
      allowAllUnixSockets: false,
    },
    filesystem: {
      denyRead: [],
      allowRead: [],
      allowWrite: [],
      denyWrite: [],
    },
    // git, gh and test runners open ptys.
    allowPty: true,
    ...(process.platform === "linux"
      ? {
          bwrapPath: fixedBinary(BWRAP_CANDIDATES),
          socatPath: fixedBinary(SOCAT_CANDIDATES),
        }
      : {}),
  };
}

/**
 * A write grant the kernel can apply. A grant is usually a file that does not
 * exist yet (the refused create, the file about to be made): bubblewrap
 * skips a nonexistent bind outright, and creating a file is a write to its
 * directory anyway, so the grant is the nearest existing ancestor.
 */
export function writableRoot(target: string): string {
  let current = target;
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/** What one command may touch, from its policy. */
export function commandConfig(
  policy: SandboxPolicy
): Partial<SandboxRuntimeConfig> {
  return {
    filesystem: {
      denyRead: [...policy.secrets.denied],
      allowRead: [...policy.secrets.allowed],
      allowWrite: [
        ...(policy.mode === "workspace-write" ? [policy.workspaceRoot] : []),
        ...policy.writableTemp,
        ...(policy.mode === "workspace-write" ? policy.toolHomes : []),
        ...policy.approvedWrites.map(writableRoot),
      ],
      denyWrite: [],
    },
  };
}

export type HostDecider = (host: string, port: number) => Promise<boolean>;

let starting: Promise<void> | null = null;
let failure: string | null = null;
let decider: HostDecider = async () => false;
const sessionHosts: string[] = [];
/** Hosts allowed for one connection each, from a card answered after a refusal. */
const onceHosts = new Set<string>();

/** Let the next connection to `host` through without another card. */
export function allowHostOnce(host: string): void {
  onceHosts.add(host.trim().toLowerCase());
}

/** Why the runtime could not start, once it has been tried; null before. */
export function runtimeFailure(): string | null {
  return failure;
}

/** Hosts the user chose "Always" for. */
export function sessionAllowedHosts(): readonly string[] {
  return sessionHosts;
}

/** Route the runtime's question about an unlisted host to the session. */
export function setHostDecider(next: HostDecider): void {
  decider = next;
}

/**
 * Start the proxies once per process. False when the runtime cannot run
 * here (bubblewrap or socat missing, an unsupported platform); the reason
 * is kept for the refusal.
 */
export async function ensureRuntime(): Promise<boolean> {
  if (failure !== null) return false;
  if (starting === null) {
    starting = SandboxManager.initialize(
      baseConfig([...DEFAULT_HOSTS, ...configuredHosts()], agentSockets()),
      ({ host, port }) =>
        onceHosts.delete(host.trim().toLowerCase())
          ? Promise.resolve(true)
          : decider(host, port ?? 0),
      true
    ).catch((error: unknown) => {
      failure = error instanceof Error ? error.message : String(error);
      starting = null;
    });
  }
  await starting;

  return failure === null;
}

/** Let every later connection to `host` through, without another card. */
export function allowHostForSession(host: string): void {
  const normalized = host.trim().toLowerCase();
  if (normalized.length === 0 || sessionHosts.includes(normalized)) return;
  sessionHosts.push(normalized);

  const current = SandboxManager.getConfig();
  if (current == null) return;
  // A live swap: the proxy reads the config per request.
  SandboxManager.updateConfig({
    ...current,
    network: {
      ...current.network,
      allowedDomains: [...current.network.allowedDomains, normalized],
    },
  });
}

/** Argv that runs `command` confined, or null when the runtime is unusable. */
export async function wrap(
  policy: SandboxPolicy,
  command: string,
  cwd: string,
  commandId: string
): Promise<string[] | null> {
  if (!(await ensureRuntime()) || !(await probe())) return null;

  const { argv } = await SandboxManager.wrapWithSandboxArgv(
    command,
    POSIX_SHELL,
    commandConfig(policy),
    undefined,
    cwd,
    { commandId, commandText: command }
  );

  return argv;
}

/**
 * The runtime's account of what a command was refused, or null. Its own
 * profile denies one sysctl every process reads at startup; that line says
 * nothing about the command and is dropped.
 */
export function violations(commandId: string): string | null {
  const annotated = SandboxManager.annotateStderrWithSandboxFailures(
    commandId,
    ""
  );
  const lines = annotated
    .split("\n")
    .filter((line) => !/deny\(\d+\) sysctl-read /.test(line));
  const body = lines.filter(
    (line) =>
      line.trim().length > 0 && !/^<\/?sandbox_violations>$/.test(line.trim())
  );

  return body.length > 0 ? lines.join("\n").trim() : null;
}

/**
 * What the runtime refused during one command, as things a card can offer.
 * Seatbelt lines read `x(pid) deny(1) file-write-create /path`, the proxy's
 * `deny network-outbound host:port (reason)`, Linux's observer `deny write
 * /path`. A direct connection the kernel refused is not offered: allowing
 * the host would change nothing, since the tool never used the proxy.
 */
export function parseDenials(lines: readonly string[]): Denial[] {
  const found: Denial[] = [];
  const seen = new Set<string>();
  const add = (denial: Denial): void => {
    const key = JSON.stringify(denial);
    if (seen.has(key)) return;
    seen.add(key);
    found.push(denial);
  };

  for (const line of lines) {
    const write =
      /deny(?:\(\d+\))? (?:file-write-\S+|write|\S+) (\/\S.*)$/.exec(line);
    const read = /deny\(\d+\) file-read-\S+ (\/\S.*)$/.exec(line);
    const host = /deny network-outbound ([^\s:]+):(\d+) \(/.exec(line);
    if (host != null)
      add({ kind: "host", host: host[1]!, port: Number(host[2]) });
    else if (read != null) add({ kind: "read", path: read[1]!.trim() });
    else if (
      write != null &&
      /file-write|deny write|deny (?:open|creat|mkdir|rename|unlink|truncate)/.test(
        line
      )
    )
      add({ kind: "write", path: write[1]!.trim() });
  }

  return found;
}

export function denials(commandId: string): Denial[] {
  return parseDenials(
    SandboxManager.getSandboxViolationStore()
      .getViolationsForCommand(commandId)
      .map((violation) => violation.line)
  );
}

/** Tests only. */
export async function resetRuntime(): Promise<void> {
  await SandboxManager.reset();
  starting = null;
  failure = null;
  sessionHosts.length = 0;
  probed = undefined;
}

let probed: boolean | undefined;

/** The argv pair the probe runs: a control, and a write outside the workspace. */
export async function probeCommands(
  writable: string,
  target: string
): Promise<{ control: string[]; canary: string[] }> {
  const policy: SandboxPolicy = {
    mode: "workspace-write",
    enforcement: "auto",
    workspaceRoot: writable,
    writableTemp: [],
    toolHomes: [],
    secrets: { denied: [], allowed: [], promptable: [] },
    approvedWrites: [],
    network: { kind: "filtered" },
  };
  const options = { commandId: "abacusai-bot-probe", commandText: "probe" };
  const control = await SandboxManager.wrapWithSandboxArgv(
    "exit 0",
    POSIX_SHELL,
    commandConfig(policy),
    undefined,
    writable,
    options
  );
  const canary = await SandboxManager.wrapWithSandboxArgv(
    `touch ${JSON.stringify(target)} 2>/dev/null`,
    POSIX_SHELL,
    commandConfig(policy),
    undefined,
    writable,
    options
  );

  return { control: control.argv, canary: canary.argv };
}

/** Confirm the runtime actually confines here, not merely that it started. */
export async function probe(exec?: ProbeExec): Promise<boolean> {
  if (probed !== undefined) return probed;

  let writable: string;
  let outside: string;
  try {
    writable = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-probe-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-canary-"));
  } catch {
    probed = false;

    return probed;
  }

  const target = path.join(outside, "canary");
  let result: boolean | null;
  try {
    const { control, canary } = await probeCommands(writable, target);
    result = probeVerdict(control, canary, exec);
  } catch {
    result = false;
  }

  if (result === true) {
    try {
      if (fs.existsSync(target)) result = false;
    } catch {
      result = false;
    }
  }

  for (const dir of [writable, outside]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Not worth failing over.
    }
  }

  // A timeout is not a verdict: refuse this command but try again next time.
  if (result === null) return false;

  probed = result;

  return probed;
}
