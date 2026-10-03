import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  FakeProvider,
  fakeProviderConfig,
} from "@abacus-ai/test-support/fake-provider";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { launch, readiness, REQUIRED, type App } from "./electron-app";

const ready = readiness();
let app: App;
let provider: FakeProvider;
let release: (() => void) | null = null;
let stopRun = false;
const THREAD = "chat-real-gate";
let workspace = "";
const session = `window.__abacusDev.chat.session(${JSON.stringify(THREAD)})`;
// All mutations below enter through rendered controls. Session reads assert
// the real host state without using its actions as a shortcut around the UI.
const clickButton = async (
  name: string,
  scope = '[data-slot="composer"]'
): Promise<void> => {
  const expression = `(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(scope + " button")})]
      .find(b => (b.getAttribute("aria-label") || b.textContent.trim()) === ${JSON.stringify(name)} && b.getBoundingClientRect().height > 0);
    return button != null && !button.disabled;
  })()`;
  await app.until(expression, 15000, `enabled ${name} control`);
  await app.evaluate(`(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(scope + " button")})]
      .find(b => (b.getAttribute("aria-label") || b.textContent.trim()) === ${JSON.stringify(name)} && b.getBoundingClientRect().height > 0);
    button.click();
  })()`);
};

const submitText = async (text: string, action = "Send"): Promise<void> => {
  await app.until(
    `document.querySelector('[data-slot="composer"] textarea') != null`,
    15000,
    "rendered composer after route loading"
  );
  await app.evaluate(
    `document.querySelector('[data-slot="composer"] textarea').focus()`
  );
  await app.send("Input.insertText", { text });
  expect(
    await app.evaluate<string>(
      `document.querySelector('[data-slot="composer"] textarea').value`
    )
  ).toBe(text);
  await clickButton(action);
  await app.until(
    `document.querySelector('[data-slot="composer"] textarea').value === ""`,
    15000,
    "draft cleared by rendered submission"
  );
};

beforeAll(async () => {
  if (!ready.runnable) return;
  ready.prepare();
  provider = await FakeProvider.start();
  provider.script((_call, index) => {
    if (stopRun) return { stall: { say: "Waiting for Stop." } };
    if (index === 0)
      return {
        say: "Checking the workspace.",
        call: { name: "bash", args: { command: "printf 'live output\\n'" } },
      };
    if (index === 1)
      return {
        call: {
          name: "edit",
          args: { path: "a.txt", oldText: "before", newText: "after" },
        },
      };
    if (index === 2)
      return new Promise((resolve) => {
        release = () => resolve({ say: "Approved edit finished." });
      });
    return { say: "Steer received." };
  });
  app = await launch({
    port: 9395,
    env: { ABACUS_API_KEY: "", ROUTELLM_API_KEY: "" },
    prepareHome: (home) => {
      workspace = join(home, "workspace");
      mkdirSync(workspace);
      writeFileSync(join(workspace, "a.txt"), "before\n");
      writeFileSync(join(home, "config.json"), fakeProviderConfig(provider));
      const now = new Date().toISOString();
      mkdirSync(join(home, "threads"));
      for (const id of ["chat-long-a", "chat-long-b"]) {
        writeFileSync(
          join(home, "threads", `${id}.json`),
          JSON.stringify({
            version: 2,
            threadId: id,
            updatedAt: now,
            source: { kind: "agui" },
            runs: [],
            messages: Array.from({ length: 500 }, (_, i) => ({
              id: `${id}-${i}`,
              role: i % 2 ? "assistant" : "user",
              parts: [{ type: "text", content: `${id} message ${i}` }],
            })),
          })
        );
      }

      writeFileSync(
        join(home, "local-code.json"),
        JSON.stringify({
          migrated_from_default_v1: true,
          localCode: {
            workspaces: [
              {
                id: "chat-w",
                label: "Chat gate",
                path: workspace,
                description: "",
                status: "ready",
              },
            ],
            activeWorkspaceId: "chat-w",
            agentSessions: [
              ...["chat-long-a", "chat-long-b"].map((id) => ({
                id,
                workspaceId: "chat-w",
                label: id,
                conversationId: null,
                createdAt: now,
                updatedAt: now,
                status: "stopped",
                agentStatus: "idle",
                model: "fake/fake-1",
                mode: "DEFAULT",
              })),
              {
                id: THREAD,
                workspaceId: "chat-w",
                label: "Chat gate",
                conversationId: null,
                createdAt: now,
                updatedAt: now,
                status: "stopped",
                agentStatus: "idle",
                model: "fake/fake-1",
                mode: "DEFAULT",
              },
            ],
            sessionArtifacts: [],
          },
        })
      );
    },
  });
  await app.evaluate(
    `window.__abacusDev.navigateAndSettle("/sessions/${THREAD}")`
  );
}, 600000);
afterAll(async () => {
  release?.();
  await app?.close();
  await provider?.close();
});
if (!ready.runnable && REQUIRED)
  describe("R2-T32", () => {
    it("can run the required Electron gate", () => {
      throw new Error(ready.skipReason);
    });
  });

describe.skipIf(!ready.runnable)("R2-T32 real session in Electron", () => {
  it("R2-T28: one nav-lateral transition between long threads snapshots the transcript end", async () => {
    await app.evaluate(
      'window.__abacusDev.navigateAndSettle("/sessions/chat-long-a")'
    );
    await app.evaluate(`(() => {
      window.__chatTransitionStarts = 0;
      window.__chatSnapshots = []; window.__chatTransitionError = null;
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = function(arg) {
        window.__chatTransitionStarts++;
        const transition = start(arg);
        transition.ready.then(() => {
          const v = document.querySelector('[data-slot="message-scroller-viewport"]');
          const last = v.querySelector('[data-message-id]:last-of-type') || [...v.querySelectorAll('[data-message-id]')].at(-1);
          window.__chatSnapshots.push({text: last.textContent, bottom: last.getBoundingClientRect().bottom, viewportBottom: v.getBoundingClientRect().bottom, scrollTop: v.scrollTop, height: v.scrollHeight, pending: v.hasAttribute("data-pending-scroll")});
        }).catch(error => window.__chatTransitionError = String(error));
        return transition;
      };
      window.__abacusDev.navTypes();
    })()`);
    await app.evaluate(
      'window.__abacusDev.navigateAndSettle("/sessions/chat-long-b")'
    );
    const result = await app.evaluate<{
      starts: number;
      types: string[];
      snapshots: Array<{
        text: string;
        bottom: number;
        viewportBottom: number;
      }>;
    }>(
      "({starts: window.__chatTransitionStarts, types: window.__abacusDev.navTypes(), snapshots: window.__chatSnapshots})"
    );
    console.info("CHAT_TRANSITION", JSON.stringify(result));
    expect(result.starts).toBe(1);
    expect(result.types).toContain("nav-lateral");

    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]!.text).toContain("chat-long-b message 499");
    expect(result.snapshots[0]!.bottom).toBeLessThanOrEqual(
      result.snapshots[0]!.viewportBottom
    );
    await app.evaluate(
      `window.__abacusDev.navigateAndSettle("/sessions/${THREAD}")`
    );
    await app.evaluate("window.__chatTransitionStarts = 0");
  }, 60000);
  it("attachment-only admission, live bash output, approval, reload, busy submission and terminal", async () => {
    await app.send("Page.setInterceptFileChooserDialog", { enabled: true });
    await clickButton("Attach");
    await app.until(
      `[...document.querySelectorAll('[role="menuitem"]')].some(b => b.textContent.trim() === "Files or images")`
    );
    await app.evaluate(
      `[...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent.trim() === "Files or images").click()`
    );
    await app.until(`document.querySelector('input[type="file"]') != null`);
    const { root } = await app.send("DOM.getDocument");
    const { nodeId } = await app.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: 'input[type="file"]',
    });
    await app.send("DOM.setFileInputFiles", {
      nodeId,
      files: [join(workspace, "a.txt")],
    });
    await app.until(
      `document.querySelector('[data-slot="composer"]').textContent.includes("a.txt")`,
      15000,
      "selected attachment chip"
    );
    expect(
      await app.evaluate<string>(
        `document.querySelector('[data-slot="composer"] textarea').value`
      )
    ).toBe("");
    await clickButton("Send");
    await app.until(
      `${session}.store.state.permissions.items.length === 1`,
      45000,
      "edit approval"
    );
    const type = await app.evaluate<string>(
      `${session}.store.state.permissions.items[0].metadata.abacus.request.type`
    );
    if (type === "run_terminal") {
      await clickButton("Allow once", '[data-slot="permission-card"]');
      await app.until(
        `${session}.store.state.permissions.items.some(p => p.metadata.abacus.request.type === "edit_file")`,
        30000,
        "edit permission after bash"
      );
    }
    expect(await app.evaluate<number>("window.__chatTransitionStarts")).toBe(0);
    expect(await app.evaluate("document.activeViewTransition == null")).toBe(
      true
    );
    expect(provider.calls[0]!.userText.join("\n")).toContain(
      `@${join(workspace, "a.txt")}`
    );
    expect(await app.evaluate<string>("document.body.textContent")).toContain(
      "live output"
    );
    await clickButton("Allow once", '[data-slot="permission-card"]');
    await app.until(
      `${session}.store.state.permissions.items.length === 0`,
      15000,
      "approval applied"
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"), {
      timeout: 20000,
    });
    await app.send("Page.reload");
    await app.until("window.__abacusDev?.chat != null", 30000);
    await app.until(
      `${session}.ready && ${session}.store.state.runs.active != null`,
      30000,
      "reload resumed active run"
    );
    await submitText("Please check the final result.", "Add to the queue");
    await app.until(
      `${session}.store.state.queue.some(entry => entry.message === "Please check the final result.")`,
      15000,
      "busy draft routed to the host queue"
    );
    expect(release).toBeTypeOf("function");
    release!();
    await app.until(
      `${session}.store.state.runs.outcomes.length === 1`,
      45000,
      "finished reply"
    );
    const result = await app.evaluate<{ ids: string[]; text: string }>(
      `({ ids: ${session}.hostStore.state.messages.map(m => m.id), text: document.body.textContent })`
    );
    expect(new Set(result.ids).size).toBe(result.ids.length);
    expect(result.text).toContain("Approved edit finished.");
    expect(result.text).toContain("Please check the final result.");
    expect(result.text).toMatch(/Done|steps/);
  }, 90000);
  it("Stop ends a real streaming run with Stopped", async () => {
    stopRun = true;
    await submitText("Wait until I stop you.");
    await app.until(
      "document.body.textContent.includes('Waiting for Stop.')",
      30000
    );
    await clickButton("Stop");
    await app.until(`${session}.store.state.runs.active == null`, 30000);
    expect(await app.evaluate<string>("document.body.textContent")).toContain(
      "Stopped"
    );
  }, 60000);
});
