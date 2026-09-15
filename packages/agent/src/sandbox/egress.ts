/**
 * The one way out to the network for a confined command: a loopback HTTP
 * proxy. The sandbox denies every other outbound connection, so a command
 * reaches a host only if this proxy agrees, and a host nobody listed can be
 * held while the user is asked. One proxy per agent process, shared by the
 * session and every sub-agent it starts, since those have no card of their
 * own to ask with.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Duplex } from "node:stream";

/**
 * Where the proxy also listens on Linux, for a sandbox whose own loopback
 * cannot reach the host's port (bubblewrap.ts). Under /tmp, which both
 * modes keep reachable.
 */
export function egressSocketPath(): string {
  return path.join(
    process.platform === "win32" ? os.tmpdir() : "/tmp",
    `abacusai-bot-egress-${process.pid}.sock`
  );
}

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

/** `example.com`, `*.example.com`; case and a trailing dot do not matter. */
export function hostMatches(host: string, pattern: string): boolean {
  const candidate = normalizeHost(host);
  const rule = normalizeHost(pattern);
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(1);

    return candidate.endsWith(suffix) && candidate.length > suffix.length;
  }

  return candidate === rule;
}

export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

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
 * The environment a confined command gets so its tools use the proxy: curl,
 * git, npm, pip, cargo and go all read these. SSH does not, so git's SSH
 * transport is pointed at a CONNECT helper unless the user set their own.
 */
export function proxyEnvironment(
  port: number,
  platform: NodeJS.Platform = process.platform,
  existing: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const url = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    ALL_PROXY: url,
    all_proxy: url,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
  };

  if (existing.GIT_SSH_COMMAND == null && platform !== "win32") {
    const helper =
      platform === "darwin"
        ? `nc -X connect -x 127.0.0.1:${port} %h %p`
        : `socat - PROXY:127.0.0.1:%h:%p,proxyport=${port}`;
    env.GIT_SSH_COMMAND = `ssh -o ProxyCommand='${helper}'`;
  }

  return env;
}

/** Asked once per host the lists do not cover; true lets the connection out. */
export type HostDecider = (host: string, port: number) => Promise<boolean>;

export class EgressProxy {
  private server: http.Server | null = null;
  private socketServer: http.Server | null = null;
  private port: number | null = null;
  private readonly sessionHosts: string[] = [];
  private readonly inFlight = new Map<string, Promise<boolean>>();
  /** Without one installed, an unlisted host is refused. */
  decider: HostDecider = async () => false;

  constructor(private readonly baseHosts: readonly string[] = DEFAULT_HOSTS) {}

  /** The listening port, or null before start. */
  get listeningPort(): number | null {
    return this.port;
  }

  /** Hosts approved for the rest of the session. */
  get sessionAllowed(): readonly string[] {
    return this.sessionHosts;
  }

  allowForSession(host: string): void {
    const normalized = normalizeHost(host);
    if (!this.sessionHosts.includes(normalized))
      this.sessionHosts.push(normalized);
  }

  isListed(host: string): boolean {
    return [...this.baseHosts, ...this.sessionHosts].some((pattern) =>
      hostMatches(host, pattern)
    );
  }

  /** One question per host at a time: parallel connections share the answer. */
  async permits(host: string, port: number): Promise<boolean> {
    const normalized = normalizeHost(host);
    if (normalized.length === 0) return false;
    if (this.isListed(normalized)) return true;

    const pending = this.inFlight.get(normalized);
    if (pending != null) return pending;

    const decision = this.decider(normalized, port).catch(() => false);
    this.inFlight.set(normalized, decision);
    try {
      return await decision;
    } finally {
      this.inFlight.delete(normalized);
    }
  }

  async start(): Promise<number> {
    if (this.port != null) return this.port;

    const server = http.createServer((request, response) =>
      this.forward(request, response)
    );
    server.on("connect", (request, socket, head) =>
      this.tunnel(request, socket, head)
    );
    // Idle keep-alive sockets would otherwise hold the process open.
    server.keepAliveTimeout = 5_000;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.unref();

    const address = server.address();
    if (address == null || typeof address === "string") {
      server.close();
      throw new Error("egress proxy did not get a TCP port");
    }

    this.server = server;
    this.port = address.port;

    if (process.platform === "linux") await this.listenOnSocket();

    return this.port;
  }

  /** The same handlers on a unix socket; a failure here costs only the bridge. */
  private async listenOnSocket(): Promise<void> {
    const socketPath = egressSocketPath();
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {
      // A stale socket from a previous process; listen() reports the rest.
    }

    const server = http.createServer((request, response) =>
      this.forward(request, response)
    );
    server.on("connect", (request, socket, head) =>
      this.tunnel(request, socket, head)
    );
    server.keepAliveTimeout = 5_000;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch {
      return;
    }
    server.unref();
    this.socketServer = server;
  }

  stop(): void {
    for (const server of [this.server, this.socketServer]) {
      server?.close();
      server?.closeAllConnections?.();
    }
    this.server = null;
    this.socketServer = null;
    this.port = null;
    try {
      fs.rmSync(egressSocketPath(), { force: true });
    } catch {
      // Nothing left to remove.
    }
  }

  /** `CONNECT host:port`, which every HTTPS client and the ssh helper send. */
  private async tunnel(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    const target = parseAuthority(request.url ?? "");
    if (target == null) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");

      return;
    }

    if (!(await this.permits(target.host, target.port))) {
      socket.end(refusal(target.host));

      return;
    }

    const upstream = net.connect(target.port, target.host);
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.once("error", () => {
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    socket.once("error", () => upstream.destroy());
    socket.once("close", () => upstream.destroy());
  }

  /** A plain `GET http://host/path` through the proxy. */
  private async forward(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url ?? "");
    } catch {
      response.writeHead(400).end();

      return;
    }

    const port = url.port.length > 0 ? Number(url.port) : 80;
    if (url.protocol !== "http:" || !(await this.permits(url.hostname, port))) {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end(`${url.hostname} is not allowed by the sandbox\n`);

      return;
    }

    const headers = { ...request.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];

    const upstream = http.request(
      {
        host: url.hostname,
        port,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      }
    );
    upstream.once("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  }
}

function parseAuthority(
  authority: string
): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(authority);
  if (match == null) return null;

  return { host: match[1]!, port: Number(match[2]) };
}

function refusal(host: string): string {
  const body = `${host} is not allowed by the sandbox\n`;

  return (
    `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n` +
    `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
  );
}

let shared: EgressProxy | null = null;

/** The process's proxy, made on first use. */
export function egressProxy(): EgressProxy {
  shared ??= new EgressProxy([...DEFAULT_HOSTS, ...configuredHosts()]);

  return shared;
}

/** Tests only. */
export function resetEgressProxy(): void {
  shared?.stop();
  shared = null;
}
