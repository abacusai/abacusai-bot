import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startRegistryProxy, UPSTREAM } from "./shadcn-registry-proxy.mjs";

const get = (url, path) =>
  new Promise((resolve, reject) => {
    const req = request(url, { path }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });

test("recording confines requests to the registry and replays long query paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-proxy-test-"));
  const originalFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url, options) => {
    fetched.push({ url: String(url), options });
    return new Response('{"registry":"fixture"}', {
      headers: { "content-type": "application/json" },
    });
  };
  let proxy = await startRegistryProxy({ mode: "record", dir, cli: "test" });
  try {
    for (const path of [
      "//127.0.0.1/private",
      "http://127.0.0.1/private",
      "/\\127.0.0.1/private",
    ])
      assert.equal((await get(proxy.url, path)).status, 400);
    assert.equal(fetched.length, 0);
    const path = `/init?theme=${"x".repeat(400)}`;
    const result = await get(proxy.url, path);
    assert.deepEqual(result, { status: 200, body: '{"registry":"fixture"}' });
    assert.equal(fetched[0].url, `${UPSTREAM}${path}`);
    assert.equal(fetched[0].options.redirect, "error");
    await proxy.close();
    proxy = null;
    const manifest = JSON.parse(
      readFileSync(join(dir, "manifest.json"), "utf8")
    );
    assert.equal(
      manifest.entries[0].file,
      `${createHash("sha256").update(path).digest("hex")}.body`
    );
    proxy = await startRegistryProxy({ mode: "replay", dir });
    assert.deepEqual(await get(proxy.url, path), result);
    assert.equal(fetched.length, 1);
  } finally {
    await proxy?.close();
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP errors do not reveal local paths or stack traces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-proxy-test-"));
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const errors = [];
  globalThis.fetch = async () => {
    throw new Error("secret local path");
  };
  console.error = (...args) => errors.push(args);
  const proxy = await startRegistryProxy({ mode: "record", dir, cli: "test" });
  try {
    assert.deepEqual(await get(proxy.url, "/r/test.json"), {
      status: 502,
      body: "registry proxy request failed",
    });
    assert.equal(errors.length, 1);
  } finally {
    await proxy.close();
    globalThis.fetch = originalFetch;
    console.error = originalError;
    rmSync(dir, { recursive: true, force: true });
  }
});
