import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import { sourceFetchProxyScript } from "./source-fetch-proxy.mjs";

test("the optional proxy requires the exact synthetic home and forwards only account stubs", async () => {
  const calls = [];
  const context = {
    process: {
      env: { ABACUSAI_BOT_HOME: "/synthetic" },
      getBuiltinModule: () => ({ existsSync: () => true }),
    },
    URL,
    Response,
    fetch: async (...args) => {
      calls.push(args);
      return new Response("{}");
    },
  };
  context.globalThis = context;
  vm.runInNewContext(
    sourceFetchProxyScript("/synthetic", "http://127.0.0.1:1234"),
    context
  );
  await context.fetch("https://routellm.abacus.ai/v1/account", {
    headers: { Authorization: "Bearer synthetic-cutover-key" },
  });
  assert.equal(calls[0][0], "http://127.0.0.1:1234/v1/account");
  assert.equal(
    (await context.fetch("https://downloads.abacus.ai/experience.zip")).status,
    404
  );
  assert.equal(calls.length, 1);
});
test("the optional proxy refuses a different home", () => {
  assert.throws(
    () =>
      vm.runInNewContext(
        sourceFetchProxyScript("/synthetic", "http://127.0.0.1:1234"),
        { process: { env: { ABACUSAI_BOT_HOME: "/somewhere-else" } } }
      ),
    /Unexpected source home/
  );
});
