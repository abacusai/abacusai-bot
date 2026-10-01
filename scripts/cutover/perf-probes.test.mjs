import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import {
  summarize,
  probeSource,
  clickLongThreadSource,
} from "./perf-probes.mjs";

test("summaries discard neither missing values nor failures as zero", () => {
  assert.deepEqual(summarize([9, 1, 5, 3, 7, 11]), {
    median: 6,
    p90: 11,
    samples: [9, 1, 5, 3, 7, 11],
  });
  assert.throws(() => summarize([]));
  assert.throws(() => summarize([1, null]));
});
test("the common probe requires a visible fixture bot and a composer that can take focus", () => {
  const callbacks = [];
  let nodes = [];
  const document = {
    activeElement: null,
    querySelectorAll: (selector) =>
      selector.includes("textarea")
        ? nodes
        : [
            {
              textContent: "Fixture bot 01",
              getClientRects: () => [1],
              click() {},
              getAttribute() {
                return null;
              },
            },
          ],
  };
  const composer = {
    disabled: false,
    getClientRects: () => [1],
    focus: () => {
      document.activeElement = composer;
    },
  };
  const context = {
    window: {},
    location: { hash: "#/bots/test" },
    document,
    performance: {
      timeOrigin: 1000,
      now: () => 50,
      getEntriesByType: () => [],
    },
    PerformanceObserver: class {
      observe() {}
    },
    getComputedStyle: () => ({ visibility: "visible" }),
    requestAnimationFrame: (callback) => callbacks.push(callback),
  };
  vm.runInNewContext(
    probeSource({ botName: "Fixture bot 01", lastMessage: "last" }),
    context
  );
  callbacks.shift()();
  assert.equal(context.window.__cutoverProbe.interactiveAt, null);
  nodes = [composer];
  callbacks.shift()();
  assert.equal(context.window.__cutoverProbe.interactiveAt, 1050);
});
test("the long-thread probe does not start timing an absent session", () => {
  const context = {
    document: { querySelectorAll: () => [] },
    window: { __cutoverProbe: {} },
  };
  assert.equal(
    vm.runInNewContext(
      clickLongThreadSource({ longSessionName: "missing" }),
      context
    ),
    false
  );
  assert.equal(context.window.__cutoverProbe.threadClickedAt, undefined);
});

test("user-login admission is distinct and public evidence omits credential manifests", async () => {
  const { validatePerfProducer, publicProducer } =
    await import("./perf-home.mjs");
  const producer = {
    kind: "perf",
    status: "complete",
    provenance: "user-login",
    sourceVersion: "v1.0.85",
    sourceGenerated: false,
    shellObserved: true,
    workload: { longSessionMessages: 1000 },
    fixture: { botName: "Fixture bot 01" },
    files: { "account.json": "private-credential-file-hash" },
    gaps: [],
  };
  assert.equal(validatePerfProducer(producer), true);
  assert.equal(
    validatePerfProducer({ ...producer, sourceGenerated: true }),
    false
  );
  assert.equal(
    validatePerfProducer({ ...producer, shellObserved: false }),
    false
  );
  assert.equal(
    validatePerfProducer({ ...producer, provenance: "unknown" }),
    false
  );
  assert.equal(
    validatePerfProducer({
      ...producer,
      workload: { longSessionMessages: 999 },
    }),
    false
  );
  assert.equal(
    JSON.stringify(publicProducer(producer)).includes("account.json"),
    false
  );
  assert.equal(publicProducer(producer).provenance, "user-login");
});

test("the driver refuses M1–M5 on an incomplete onboarding fixture before launch", async () => {
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cutover-refusal-"));
  const manifest = path.join(root, "producer.json"),
    out = path.join(root, "report.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      kind: "perf",
      status: "incomplete",
      gaps: ["shell not admitted"],
    })
  );
  try {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            new URL("./perf-compare.mjs", import.meta.url).pathname,
            "--old",
            "missing-old",
            "--new",
            "missing-new",
            "--home",
            root,
            "--producer",
            manifest,
            "--out",
            out,
          ],
          { stdio: "pipe" }
        ),
      (error) =>
        String(error.stderr).includes("completed, source-produced perf-home")
    );
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("home copies verify files and never change the source", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { copyPerfHome, homeManifest } = await import("./perf-home.mjs");
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "perf-source-"));
  fs.writeFileSync(path.join(source, "account.json"), "private test fixture");
  const manifest = homeManifest(source);
  const copy = copyPerfHome(source, manifest);
  try {
    fs.writeFileSync(path.join(copy.home, "account.json"), "changed scratch");
    assert.deepEqual(homeManifest(source), manifest);
    assert.throws(
      () => copyPerfHome(source, { "../account.json": "bad" }),
      /Unsafe/
    );
    assert.throws(
      () => copyPerfHome(source, { "account.json": "bad" }),
      /hash mismatch/
    );
  } finally {
    copy.dispose();
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test("a landing-page composer cannot satisfy the short-session probe", () => {
  const callbacks = [];
  let now = 0,
    loaded = false;
  const session = {
    tagName: "A",
    textContent: "Short session",
    getClientRects: () => [1],
    getAttribute: () => null,
    click: () => {},
  };
  const document = {
    activeElement: null,
    querySelectorAll: (selector) =>
      selector.includes("textarea")
        ? [composer]
        : selector.startsWith("p,")
          ? loaded
            ? [
                {
                  textContent: "Fixture final message s",
                  getClientRects: () => [1],
                },
              ]
            : []
          : [session],
  };
  const composer = {
    disabled: false,
    getClientRects: () => [1],
    focus: () => {
      document.activeElement = composer;
    },
  };
  const context = {
    window: {},
    document,
    location: { hash: "#/sessions/s" },
    performance: {
      timeOrigin: 1000,
      now: () => now,
      getEntriesByType: () => [],
    },
    PerformanceObserver: class {
      observe() {}
    },
    getComputedStyle: () => ({ visibility: "visible" }),
    requestAnimationFrame: (cb) => callbacks.push(cb),
  };
  vm.runInNewContext(
    probeSource({
      initialSessionName: "Short session",
      initialSessionId: "s",
      botName: "Bot",
    }),
    context
  );
  callbacks.shift()();
  now = 200;
  callbacks.shift()();
  assert.equal(context.window.__cutoverProbe.interactiveAt, null);
  loaded = true;
  callbacks.shift()();
  assert.equal(context.window.__cutoverProbe.interactiveAt, 1200);
});
