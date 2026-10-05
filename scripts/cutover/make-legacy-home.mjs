import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { BOT_TEMPLATES } from "../../packages/contract/src/bots/templates.ts";
import { accountStub } from "./account-stub.mjs";
import { launch, connect } from "./cdp.mjs";
import { sourceFetchProxyScript } from "./source-fetch-proxy.mjs";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    "source-archive": { type: "string" },
    version: { type: "string" },
    out: { type: "string" },
    kind: { type: "string", default: "migration" },
    port: { type: "string", default: "9340" },
    archive: { type: "string" },
    "instrument-source-fetch": { type: "boolean", default: false },
  },
});
if (
  !values.source ||
  !values["source-archive"] ||
  !values.version ||
  !values.out ||
  !["migration", "perf"].includes(values.kind)
)
  throw new Error(
    "Required: --source <packaged executable> --source-archive <original archive> --version <version> --out <fresh directory> [--kind migration|perf]"
  );
const root = path.resolve(values.out);
if (fs.existsSync(root))
  throw new Error(`Fixture is immutable: ${root} already exists`);
fs.mkdirSync(root, { recursive: true });
const home = path.join(root, "home");
fs.mkdirSync(home);
fs.writeFileSync(
  path.join(home, ".synthetic-cutover-home"),
  "Generated synthetic data only\n"
);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const producer = {
  sourceVersion: values.version,
  sourceArchiveSha256: sha256(fs.readFileSync(values["source-archive"])),
  sourceBinarySha256: sha256(fs.readFileSync(values.source)),
  generatorDirty:
    execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      encoding: "utf8",
    }).trim() !== "",
  generatorScriptSha256: sha256(fs.readFileSync(import.meta.filename)),
  generatorCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  os: `${process.platform}-${process.arch}`,
  kind: values.kind,
  status: "incomplete",
  calls: [],
  gaps: [],
  files: {},
};
const git = (cwd, ...args) =>
  execFileSync("/usr/bin/git", args, { cwd, stdio: "pipe" });
// All repos, worktrees and application writes stay inside this fresh synthetic root.
git(home, "init", "-q");
git(
  home,
  "-c",
  "user.name=Synthetic fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "commit",
  "--allow-empty",
  "-qm",
  "Synthetic fixture"
);
const repos = [home];
for (let i = 1; i < 3; i++) {
  const repo = path.join(home, `workspace-${i}`);
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(
    repo,
    "-c",
    "user.name=Synthetic fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "Synthetic fixture"
  );
  repos.push(repo);
}
for (let i = 0; i < 2; i++)
  git(
    home,
    "worktree",
    "add",
    "-qb",
    `fixture-${i}`,
    path.join(root, `worktree-${i}`)
  );
const stub = values.kind === "perf" ? await accountStub(root) : null;
const app = await launch({
  directPage: true,
  args: stub
    ? [
        `--proxy-server=${stub.url}`,
        "--ignore-certificate-errors",
        ...(values["instrument-source-fetch"] ? ["--inspect=9360"] : []),
      ]
    : [],
  env: stub
    ? {
        HTTP_PROXY: stub.url,
        HTTPS_PROXY: stub.url,
        ALL_PROXY: stub.url,
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      }
    : {},
  executable: path.resolve(values.source),
  home,
  port: Number(values.port),
  log: path.join(root, "source.log"),
});
const call = async (member, ...args) => {
  producer.calls.push({
    member,
    args:
      member === "agent.writeTranscript"
        ? [args[0], { segments: args[1].length }]
        : args,
  });
  if (member === "agent.writeTranscript") {
    const [id, history] = args;
    const encoded = history.map((segment) => {
      const prefix = `Fixture ${id} `;
      if (
        typeof segment.content === "string" &&
        segment.content.length > 4096 &&
        segment.content.startsWith(prefix)
      ) {
        const chars = segment.content.length - prefix.length;
        return JSON.stringify({ ...segment, content: null }).replace(
          '"content":null',
          `"content":${JSON.stringify(prefix)} + "Synthetic text. ".repeat(Math.ceil(${chars} / 16)).slice(0, ${chars})`
        );
      }
      return JSON.stringify(segment);
    });
    return app.cdp.evaluate(
      `window.api.agent.writeTranscript(${JSON.stringify(id)}, [${encoded.join(",")}])`
    );
  }
  return app.cdp.evaluate(`window.api.${member}(...${JSON.stringify(args)})`);
};
try {
  if (values["instrument-source-fetch"]) {
    if (!stub) {
      app.cdp.close();
      await app.stop();
      throw new Error("Fetch instrumentation is for --kind perf only");
    }
    const targets = await fetch("http://127.0.0.1:9360/json/list").then(
      (response) => response.json()
    );
    const inspector = await connect(targets[0].webSocketDebuggerUrl);
    const script = sourceFetchProxyScript(home, stub.url);
    try {
      producer.instrumentation = {
        result: await inspector.evaluate(script),
        scriptSha256: sha256(script),
        source: script,
      };
    } finally {
      inspector.close();
    }
  }
  for (let i = 0; i < 300; i++) {
    if (await app.cdp.evaluate("!!window.api?.agent && !!document.body")) break;
    await delay(100);
  }
  const workspaces = [];
  for (const repo of repos)
    workspaces.push(await call("agent.addWorkspace", repo));
  fs.writeFileSync(
    path.join(root, "workspaces-observed.json"),
    JSON.stringify(workspaces, null, 2)
  );
  const metadata = await call("agent.getMetadata");
  const workspaceIds = metadata.workspaces.map((w) => w.id);
  if (workspaceIds.length < 3)
    throw new Error("Source did not register three workspaces");
  const bots = [];
  for (let i = 0; i < 12; i++)
    bots.push(
      await call("agent.createBot", {
        name: `Fixture bot ${String(i + 1).padStart(2, "0")}`,
        title: BOT_TEMPLATES[i].title,
        description: BOT_TEMPLATES[i].mission,
        persona: BOT_TEMPLATES[i].persona,
        avatarColor: ["#3b82f6", "#22c55e", "#a855f7"][i % 3],
        avatarShape: ["cone", "pebble", "cloud"][i % 3],
        workspaceId: workspaceIds[i % 3],
      })
    );
  const missingRepo = path.join(root, "missing-workspace");
  fs.mkdirSync(missingRepo);
  git(missingRepo, "init", "-q");
  await call("agent.addWorkspace", missingRepo);
  const missingWorkspace = (await call("agent.getMetadata")).workspaces.find(
    (w) => w.path === missingRepo
  );
  if (!missingWorkspace)
    throw new Error("Missing-workspace seed was not registered");
  const sessions = [];
  for (let i = 0; i < 40; i++) {
    const workspaceId = i >= 37 ? missingWorkspace.id : workspaceIds[i % 3];
    const session = await call("agent.createAgentSession", workspaceId);
    await call(
      "agent.updateAgentSessionLabel",
      workspaceId,
      session.id,
      `Fixture session ${String(i + 1).padStart(2, "0")}`
    );
    sessions.push({ ...session, workspaceId });
  }
  const segments = (id, chars = 90_000, count = 2) =>
    Array.from({ length: count }, (_, i) => ({
      id: `${id}-segment-${i}`,
      type: "text",
      source: i % 2 ? "bot" : "user",
      at: 1788256800000 + i,
      content:
        i === count - 1
          ? `Fixture final message ${id}`
          : `Fixture ${id} ` +
            "Synthetic text. ".repeat(Math.ceil(chars / 16)).slice(0, chars),
    }));
  for (let i = 0; i < 2000; i++) {
    const id =
      sessions[i]?.id ?? `fixture-history-${String(i).padStart(4, "0")}`;
    const chars =
      i === 0 ? 30 * 1024 * 1024 : i >= 1 && i <= 3 ? 65 * 1024 * 1024 : 90_000;
    const history = i === 4 ? segments(id, 100, 1000) : segments(id, chars);
    if (i === 5)
      history.push({
        id: "fixture-tool",
        type: "tool_call",
        toolCall: {
          id: "fixture-tool-call",
          name: "read_file",
          args: { path: "fixture.txt" },
          status: "success",
        },
        toolResult: {
          toolCallId: "fixture-tool-call",
          output: "synthetic tool output",
        },
        at: 1788256800002,
      });
    if (i === 6)
      history.push({
        id: "fixture-diff",
        type: "text",
        source: "bot",
        content: "```diff\n-old\n+synthetic\n```",
        at: 1788256800003,
      });
    await call("agent.writeTranscript", id, history);
    if (i % 100 === 0) console.log(`source wrote ${i + 1}/2000 histories`);
  }
  await call("agent.removeWorkspace", missingWorkspace.id);
  fs.rmSync(missingRepo, { recursive: true, force: true });
  await call("agent.switchWorkspace", workspaceIds[0]);
  fs.mkdirSync(path.join(home, "memories"), { recursive: true });
  const memoryWrite = await call(
    "agent.writeFile",
    path.join(home, "memories/MEMORY.md"),
    Array.from({ length: 20 }, (_, i) => `- Synthetic memory ${i + 1}`).join(
      "\n§\n"
    ) + "\n"
  );
  if (!memoryWrite.success)
    throw new Error(
      `Source memory write refused: ${JSON.stringify(memoryWrite)}`
    );
  const memories = await call("agent.listMemories");
  if (memories.memory.length !== 20)
    throw new Error(
      `Expected 20 source-readable memories, got ${memories.memory.length}`
    );
  const geometry = await call(
    "agent.writeFile",
    path.join(home, "electron/window-state.json"),
    JSON.stringify({ windowWidth: 1280, windowHeight: 800 })
  );
  if (!geometry.success)
    throw new Error("Source API refused window-state write");
  const routines = [];
  for (let i = 0; i < 6; i++) {
    const routine = await call("agent.createRoutine", {
      name: `Fixture routine ${i + 1}`,
      prompt: "Synthetic offline run",
      workspaceId: workspaceIds[0],
    });
    routines.push(routine);
    for (let run = 0; run < 20; run++)
      await call("agent.runRoutine", routine.id, "manual");
  }
  const storedRoutines = await call("agent.listRoutines");
  const routineRunCounts = storedRoutines.map((routine) => routine.runs.length);
  if (routineRunCounts.reduce((sum, count) => sum + count, 0) !== 120)
    throw new Error(
      `Source did not retain 120 recorded run attempts: ${routineRunCounts}`
    );
  producer.routineRunEvidence = {
    recordedAttempts: 120,
    completedExecution:
      "Not claimed; offline runs include source-recorded skipped attempts.",
  };
  const pairing = await call("agent.decideMessagingPairing", {
    platformId: "whatsapp",
    userId: "fixture-sender",
    decision: "approve",
  });
  if (!JSON.stringify(pairing).includes("fixture-sender"))
    producer.gaps.push(
      "Shipped decideMessagingPairing cannot create an absent sender; a source-written auto-reply grant still needs an inbound pairing fixture."
    );
  const preferences = {
    theme: "dark",
    "abacusai-bot-language": "en-US",
    "local-code-ui-store": JSON.stringify({
      version: 4,
      state: {
        pinnedBotIds: bots.slice(0, 3).map((b) => b.id),
        pinnedSessionIds: sessions.slice(0, 5).map((s) => s.id),
        isSidebarVisible: true,
        workspaceAccordionExpanded: Object.fromEntries(
          workspaceIds.map((id) => [id, true])
        ),
        favoriteModelIds: [],
        workspaceSelectedModelIds: {},
      },
    }),
    "sidebar-accordion": JSON.stringify({
      version: 0,
      state: { openSection: "bots" },
    }),
    "abacus-credits": JSON.stringify({
      version: 0,
      state: { exhaustedAt: null },
    }),
    "abacusai-bot-code-folder": JSON.stringify({
      version: 0,
      state: { currentFolder: repos[0], recentFolders: repos },
    }),
    "browser.homepage": "https://example.invalid",
    "onboarding.step": "models",
    "referral-card.dismissed-until": "0",
    "local-code:upsell-dismissed": "false",
  };
  for (const [key, value] of Object.entries(preferences))
    await call("durableState.set", key, value);
  await delay(1000);
  producer.fixture = {
    botName: bots[0].name,
    longSessionName: "Fixture session 05",
    longSessionId: sessions[4].id,
    lastMessage: `Fixture final message ${sessions[4].id}`,
    bots,
    sessions,
    routines,
  };

  if (values.kind === "perf") {
    await call("skipAccountOnboarding");
    await call("agent.saveApiKey", "abacus", "synthetic-cutover-key");
    await app.cdp.send("Page.reload");
    let shell = false;
    for (let i = 0; i < 300; i++) {
      shell = await app.cdp
        .evaluate(
          `document.body?.innerText.includes("Fixture bot 01") && !!document.querySelector('textarea,[contenteditable="true"]')`
        )
        .catch(() => false);
      if (shell) break;
      await delay(100);
    }
    producer.accountStub = {
      requests: stub.requests,
      credential: "synthetic-cutover-key",
      proxy: "loopback-only CONNECT stub",
      nodeTlsVerification: "disabled for this synthetic subprocess only",
    };
    if (!shell)
      throw new Error(
        "Perf fixture refused: source shell admission did not complete using the local account stub"
      );
    producer.onboardingCompleted = true;
  }
} catch (error) {
  producer.gaps.push(String(error));
} finally {
  app.cdp.close();
  await app.stop();
  if (stub) await stub.close();
  // The spec permits constructing the second profile registry without real sign-in.
  const second = path.join(home, "profiles", "synthetic-second");
  fs.mkdirSync(second, { recursive: true });
  for (const entry of [
    "bots.json",
    "local-code.json",
    "cronjobs.json",
    "transcripts",
    "memories",
  ])
    if (fs.existsSync(path.join(home, entry)))
      fs.cpSync(path.join(home, entry), path.join(second, entry), {
        recursive: true,
      });
  fs.mkdirSync(path.join(second, "electron"));
  for (const entry of ["renderer-state.json", "window-state.json"])
    if (fs.existsSync(path.join(home, "electron", entry)))
      fs.copyFileSync(
        path.join(home, "electron", entry),
        path.join(second, "electron", entry)
      );
  const registryFile = path.join(home, "profiles.json");
  const registry = fs.existsSync(registryFile)
    ? JSON.parse(fs.readFileSync(registryFile, "utf8"))
    : { active: "synthetic-first", profiles: { "synthetic-first": "." } };
  registry.profiles["synthetic-second"] = "profiles/synthetic-second";
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  producer.secondProfile = "profiles/synthetic-second";
  // These are the only deliberately malformed files; all normal histories came from the source API.
  fs.mkdirSync(path.join(home, "transcripts"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "transcripts/fixture-corrupt.json"),
    "{synthetic malformed"
  );
  fs.writeFileSync(
    path.join(home, "transcripts/fixture-unknown.json"),
    JSON.stringify({ version: 999, segments: [] })
  );
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const file = path.join(dir, e.name);
      const relative = path.relative(home, file);
      if (e.name === ".git" || e.isSymbolicLink()) return [];
      if (
        relative.startsWith(`electron${path.sep}`) &&
        ![
          "electron/renderer-state.json",
          "electron/window-state.json",
        ].includes(relative)
      )
        return [];
      return e.isDirectory() ? walk(file) : [file];
    });
  for (const file of walk(home))
    producer.files[path.relative(home, file)] = sha256(fs.readFileSync(file));
  producer.status = producer.gaps.length ? "incomplete" : "complete";
  fs.writeFileSync(
    path.join(root, "producer.json"),
    JSON.stringify(producer, null, 2) + "\n"
  );
}
if (values.archive) {
  const archive = path.resolve(values.archive);
  if (fs.existsSync(archive))
    throw new Error(`Immutable archive already exists: ${archive}`);
  if (producer.status !== "complete" && !archive.endsWith(".partial.tar.zst"))
    throw new Error(
      "An incomplete source fixture must use a .partial.tar.zst name"
    );
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const list = path.join(root, "archive-files.txt");
  fs.writeFileSync(list, Object.keys(producer.files).join("\n") + "\n");
  execFileSync("tar", ["--zstd", "-cf", archive, "-C", home, "-T", list], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  fs.copyFileSync(
    path.join(root, "producer.json"),
    archive.replace(/\.tar\.zst$/, ".producer.json")
  );
}
if (producer.gaps.length) {
  console.error(producer.gaps.join("\n"));
  process.exitCode = 1;
}
