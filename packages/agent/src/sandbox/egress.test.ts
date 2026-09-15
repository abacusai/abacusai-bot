/**
 * The egress proxy against real sockets: a local origin stands in for the
 * internet, and a client goes through the proxy both ways HTTP clients do,
 * plain forwarding and CONNECT.
 */
import * as http from "node:http";
import * as net from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  configuredHosts,
  EgressProxy,
  hostMatches,
  normalizeHost,
  proxyEnvironment,
} from "./egress.js";

describe("host matching", () => {
  it("matches exactly, or by wildcard suffix", () => {
    expect(hostMatches("github.com", "github.com")).toBe(true);
    expect(hostMatches("GitHub.com.", "github.com")).toBe(true);
    expect(
      hostMatches("raw.githubusercontent.com", "*.githubusercontent.com")
    ).toBe(true);
    expect(
      hostMatches("githubusercontent.com", "*.githubusercontent.com")
    ).toBe(false);
    expect(hostMatches("evil-github.com", "github.com")).toBe(false);
    expect(hostMatches("github.com.evil.test", "github.com")).toBe(false);
  });

  it("strips IPv6 brackets", () => {
    expect(normalizeHost("[::1]")).toBe("::1");
  });

  it("reads extra hosts from the environment", () => {
    expect(
      configuredHosts({ ABACUSAI_BOT_SANDBOX_HOSTS: " a.test, *.b.test ,, " })
    ).toEqual(["a.test", "*.b.test"]);
    expect(configuredHosts({})).toEqual([]);
  });
});

describe("the child environment", () => {
  it("points every proxy-aware tool at the port and keeps loopback direct", () => {
    const env = proxyEnvironment(4321, "linux", {});
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:4321");
    expect(env.http_proxy).toBe("http://127.0.0.1:4321");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
  });

  it("routes git's ssh through a CONNECT helper unless the user set one", () => {
    expect(proxyEnvironment(4321, "darwin", {}).GIT_SSH_COMMAND).toContain(
      "nc -X connect -x 127.0.0.1:4321"
    );
    expect(proxyEnvironment(4321, "linux", {}).GIT_SSH_COMMAND).toContain(
      "socat - PROXY:127.0.0.1:%h:%p,proxyport=4321"
    );
    expect(
      proxyEnvironment(4321, "linux", { GIT_SSH_COMMAND: "ssh -v" })
        .GIT_SSH_COMMAND
    ).toBeUndefined();
    expect(proxyEnvironment(4321, "win32", {}).GIT_SSH_COMMAND).toBeUndefined();
  });
});

describe("the proxy against real sockets", () => {
  let origin: http.Server;
  let originPort: number;
  let proxy: EgressProxy;
  let proxyPort: number;
  const asked: string[] = [];

  beforeAll(async () => {
    origin = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`origin saw ${request.method} ${request.url}`);
    });
    await new Promise<void>((resolve) =>
      origin.listen(0, "127.0.0.1", () => resolve())
    );
    originPort = (origin.address() as net.AddressInfo).port;

    proxy = new EgressProxy(["allowed.test"]);
    proxy.decider = async (host) => {
      asked.push(host);

      return host === "asked-yes.test";
    };
    proxyPort = await proxy.start();
  });

  afterAll(() => {
    proxy.stop();
    origin.close();
  });

  /** A plain HTTP request through the proxy for `http://host/`. */
  function viaProxy(host: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          method: "GET",
          path: `http://${host}:${originPort}/hello`,
          // The origin is local; the Host header is what the proxy reasons about.
          headers: { host: `${host}:${originPort}` },
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, body })
          );
        }
      );
      request.on("error", reject);
      request.end();
    });
  }

  /** The first response line to a CONNECT for `host:port`. */
  function connectVia(host: string, port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1", () => {
        socket.write(
          `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`
        );
      });
      socket.once("data", (data) => {
        resolve(data.toString().split("\r\n")[0] ?? "");
        socket.destroy();
      });
      socket.once("error", reject);
    });
  }

  it("refuses a host nobody listed and the decider declines", async () => {
    const reply = await viaProxy("asked-no.test");
    expect(reply.status).toBe(403);
    expect(reply.body).toContain("asked-no.test");
    expect(asked).toContain("asked-no.test");
  });

  it("refuses a CONNECT the same way", async () => {
    expect(await connectVia("asked-no.test", 443)).toBe(
      "HTTP/1.1 403 Forbidden"
    );
  });

  it("tunnels a CONNECT to a listed host", async () => {
    // 127.0.0.1 resolves for real; the name is what the allowlist checks.
    proxy.allowForSession("127.0.0.1");
    expect(await connectVia("127.0.0.1", originPort)).toBe(
      "HTTP/1.1 200 Connection Established"
    );
  });

  it("forwards plain HTTP to a host the decider approved", async () => {
    // asked-yes.test does not resolve; only the decision is under test here,
    // which is what turns 403 into the connection attempt (502).
    const reply = await viaProxy("asked-yes.test");
    expect(reply.status).toBe(502);
    expect(asked.filter((host) => host === "asked-yes.test")).toHaveLength(1);
  });

  it("asks once per host while connections are in flight", async () => {
    let calls = 0;
    let release: (value: boolean) => void = () => undefined;
    proxy.decider = async () => {
      calls += 1;

      return new Promise<boolean>((resolve) => {
        release = resolve;
      });
    };
    const first = proxy.permits("burst.test", 443);
    const second = proxy.permits("burst.test", 443);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release(false);
    expect(await Promise.all([first, second])).toEqual([false, false]);
    expect(calls).toBe(1);
  });

  it("remembers a host allowed for the session", () => {
    proxy.allowForSession("Later.Test.");
    expect(proxy.isListed("later.test")).toBe(true);
    expect(proxy.sessionAllowed).toContain("later.test");
  });

  it("rejects a malformed CONNECT authority", async () => {
    expect(await connectVia("nonsense", NaN)).toBe("HTTP/1.1 400 Bad Request");
  });
});
