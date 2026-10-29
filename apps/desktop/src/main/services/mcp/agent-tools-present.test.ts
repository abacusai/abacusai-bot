/**
 * `present_deliverable`: what actually reaches the preview pane.
 *
 * The tool takes a list; every item becomes a row of the chat's files card,
 * and only the first (the primary) goes to the preview pane. A bot's turn
 * sends nothing to the pane at all. The broadcast is stored in main until a
 * pane answers; the result claims the pane only when one answered in ~1 s.
 */
import fs from "fs";
import http from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";

import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { servePreview } from "../agent-tools/served-previews";
import { stopAllServed } from "../agent-tools/static-server";
import { PreviewTargets } from "../session/preview-targets";
import { McpAgentToolsServer } from "./mcp-agent-tools-server";

const sent = vi.fn();

vi.mock("#main/rpc/emit", () => ({
  emitHostEvent: (payload: unknown) => sent("bus", payload),
}));

const server = (extra: Record<string, unknown> = {}): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set<string>(),
    workspacePath: () => null,
    ...extra,
  } as never);

type Executable = {
  executeTool: (
    name: string,
    args: Record<string, unknown>,
    session?: string
  ) => Promise<{ content: { text?: string }[] }>;
};

/** The paths the broadcast carried, in the order they were sent. */
const present = async (
  items: { path: string; label?: string }[]
): Promise<string[]> => {
  await (
    server() as unknown as {
      executeTool: (
        name: string,
        args: Record<string, unknown>,
        session?: string
      ) => Promise<{ content: { text?: string }[] }>;
    }
  ).executeTool("present_deliverable", { items }, "session-1");

  return sent.mock.calls.map((call) => (call[1] as { path: string }).path);
};

/** Local apps that answer: a presented local URL is asked first. */
const apps: http.Server[] = [];
let APP = "";
let APP2 = "";
let APP3 = "";
let API = "";

const listening = async (): Promise<string> => {
  const app = http.createServer((_request, response) => {
    response
      .writeHead(200, { "Content-Type": "text/html" })
      .end("<h1>App</h1>");
  });
  apps.push(app);
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  return `http://localhost:${(app.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  [APP, APP2, APP3, API] = await Promise.all([
    listening(),
    listening(),
    listening(),
    listening(),
  ]);
});

afterAll(async () => {
  for (const app of apps) await new Promise((resolve) => app.close(resolve));
});

beforeEach(() => {
  sent.mockReset();
});

describe("presenting URLs", () => {
  it("opens the one it was given", async () => {
    expect(await present([{ path: APP }])).toEqual([APP]);
  });

  it("opens only the first; the rest are rows of the files card", async () => {
    const paths = await present([
      { path: APP },
      { path: APP2 },
      { path: APP3 },
    ]);

    expect(paths).toEqual([APP]);
  });
});

describe("presenting from a bot's chat", () => {
  it("opens no pane, and says the card is where the file is", async () => {
    const result = await (
      server({
        botIdForSession: (session: string) =>
          session === "bot-session" ? "bot-1" : null,
      }) as unknown as Executable
    ).executeTool(
      "present_deliverable",
      { items: [{ path: APP }] },
      "bot-session"
    );

    expect(sent).not.toHaveBeenCalled();
    const text = result.content.map((part) => part.text ?? "").join("");
    expect(text).toContain(APP);
    expect(text).not.toContain("preview pane");
  });
});

describe("a name the model transcribed", () => {
  it("is located by how it reads, and declared under its real name", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "present-"));
    const real = path.join(
      dir,
      "Screenshot 2026-09-14 at 12.55.59\u202fAM.png"
    );
    fs.writeFileSync(real, "png");

    const result = await (server() as unknown as Executable).executeTool(
      "present_deliverable",
      {
        items: [
          { path: path.join(dir, "Screenshot 2026-09-14 at 12.55.59 AM.png") },
        ],
      },
      "session-1"
    );

    const text = result.content.map((part) => part.text ?? "").join("");
    expect(text).toContain(`[artifact] ${real}`);
    expect(text).not.toContain("Not presented");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("what the result declares", () => {
  it("is exactly the items that exist, one marker line each", async () => {
    const result = await (server() as unknown as Executable).executeTool(
      "present_deliverable",
      {
        items: [
          { path: APP, label: "The app" },
          { path: "/nowhere/user@a.com_user@b.com", label: "placeholder" },
          { path: API },
        ],
      },
      "session-1"
    );

    const text = result.content.map((part) => part.text ?? "").join("");
    const declared = text
      .split("\n")
      .filter((line) => line.startsWith("[artifact] "));
    expect(declared).toEqual([`[artifact] ${APP}`, `[artifact] ${API}`]);
    expect(text).toContain("Not presented, because there is no file");
  });
});

describe("presenting nothing that exists", () => {
  it("opens no pane and says so", async () => {
    const result = await (
      server() as unknown as {
        executeTool: (
          name: string,
          args: Record<string, unknown>,
          session?: string
        ) => Promise<{ content: { text?: string }[] }>;
      }
    ).executeTool(
      "present_deliverable",
      { items: [{ path: "/nope/missing.pdf" }] },
      "session-1"
    );

    expect(sent).not.toHaveBeenCalled();
    expect(result.content.map((part) => part.text ?? "").join("")).toContain(
      "none of those exist"
    );
  });
});

describe("which pane it lands in", () => {
  it("names the caller's conversation, so it opens in that chat and no other", async () => {
    const key = sessionConversationKey("workspace-1", "session-1");
    await (
      server({
        conversationKeyForSession: (sessionId: string) =>
          sessionId === "session-1" ? key : null,
      }) as unknown as Executable
    ).executeTool(
      "present_deliverable",
      { items: [{ path: APP }] },
      "session-1"
    );

    expect(sent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "preview-open",
        path: APP,
        conversationKey: key,
      })
    );
  });

  it("leaves the key off when the session is not known", async () => {
    await (server() as unknown as Executable).executeTool(
      "present_deliverable",
      { items: [{ path: APP }] },
      "session-1"
    );

    const payload = sent.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("conversationKey");
  });
});

describe("what the model is told about the pane", () => {
  const key = sessionConversationKey("workspace-1", "session-1");
  const run = async (
    answer: ((id: string, targets: PreviewTargets) => void) | null,
    extra: Record<string, unknown> = {},
    delay = 20
  ) => {
    const targets = new PreviewTargets();
    sent.mockImplementation((_bus, event: { id?: string }) => {
      if (answer != null && event.id != null)
        setTimeout(() => answer(event.id!, targets), delay);
    });
    const started = performance.now();
    const result = await (
      server({
        previewTargets: targets,
        conversationKeyForSession: () => key,
        ...extra,
      }) as unknown as Executable
    ).executeTool(
      "present_deliverable",
      { items: [{ path: APP, label: "The app" }] },
      "session-1"
    );
    return {
      text: result.content.map((part) => part.text ?? "").join(""),
      took: performance.now() - started,
      targets,
    };
  };

  it("says it is open only once the pane reported its page drew", async () => {
    const { text, took, targets } = await run((id, t) =>
      t.handled(key, id, true)
    );
    expect(text).toContain("The app is open in the preview pane.");
    expect(took).toBeLessThan(500);
    expect(targets.pending(key)).toBeNull();
  });

  it("without an answer in ~1 s, says it opens when the user views the session, and keeps it", async () => {
    const { text, took, targets } = await run(null);
    expect(text).toContain(
      "The app opens in the preview pane when the user views this session."
    );
    expect(text).not.toContain("is open in the preview pane");
    expect(took).toBeGreaterThanOrEqual(950);
    expect(took).toBeLessThan(1_500);
    expect(targets.pending(key)).toEqual({
      id: expect.any(String),
      path: APP,
    });
  });

  it("a draw that failed (or a pane that declined it) leaves only the files card", async () => {
    const { text } = await run((id, t) => t.handled(key, id, false));
    expect(text).toContain(
      "Listed in the chat as a files card the user can open."
    );
    expect(text).not.toContain("preview pane");
  });

  it("a draw slower than ~1 s gets the honest fallback, and the late answer still clears it", async () => {
    const { text, took, targets } = await run(
      (id, t) => t.handled(key, id, true),
      {},
      1_200
    );
    expect(text).toContain("when the user views this session");
    expect(text).not.toContain("is open in the preview pane");
    expect(took).toBeLessThan(1_150);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(targets.pending(key)).toBeNull();
  });

  it("a bot's turn stores and waits on nothing", async () => {
    const { took, targets } = await run(null, {
      botIdForSession: () => "bot-1",
    });
    expect(sent).not.toHaveBeenCalled();
    expect(took).toBeLessThan(500);
    expect(targets.pending(key)).toBeNull();
  });
});

describe("a local app handed over as done", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "present-home-"));
  const savedHome = process.env.ABACUSAI_BOT_HOME;
  beforeAll(() => {
    process.env.ABACUSAI_BOT_HOME = home;
  });
  afterAll(() => {
    stopAllServed();
    if (savedHome == null) delete process.env.ABACUSAI_BOT_HOME;
    else process.env.ABACUSAI_BOT_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const presentText = async (
    items: { path: string }[],
    extra: Record<string, unknown> = {}
  ): Promise<{ text: string; isError: boolean }> => {
    const result = (await (server(extra) as unknown as Executable).executeTool(
      "present_deliverable",
      { items },
      "session-1"
    )) as {
      content: { text?: string }[];
      isError?: boolean;
    };
    return {
      text: result.content.map((part) => part.text ?? "").join(""),
      isError: result.isError === true,
    };
  };

  /** A local URL nothing answers: the server of an app that is not running. */
  const stoppedUrl = async (): Promise<string> => {
    const app = http.createServer();
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    await new Promise((resolve) => app.close(resolve));
    return url;
  };

  it("is refused when nothing answers there, and opens no pane", async () => {
    const dead = await stoppedUrl();
    const { text, isError } = await presentText([{ path: dead }]);

    expect(isError).toBe(true);
    expect(text).toContain("Nothing could be presented");
    expect(text).toContain(`${dead}: nothing is listening there`);
    expect(sent).not.toHaveBeenCalled();
  });

  it("says what was checked when it answers", async () => {
    const { text } = await presentText([{ path: APP }]);

    expect(text).toContain("Checked:");
    expect(text).toContain(`${APP} answered (HTTP 200).`);
  });

  /** An update restarts the app; every served page died with it. */
  it("is a served folder brought back on its own URL after a restart", async () => {
    const site = fs.mkdtempSync(path.join(home, "site-"));
    fs.writeFileSync(path.join(site, "index.html"), "<h1>Game</h1>");
    const before = await servePreview(site);
    stopAllServed();
    await expect(fetch(before.url)).rejects.toThrow();

    const { text, isError } = await presentText([{ path: before.url }]);

    expect(isError).toBe(false);
    expect(text).toContain(`[artifact] ${before.url}`);
    expect(await (await fetch(before.url)).text()).toContain("Game");
  });

  it("is refused when its page throws as it loads, with what it threw", async () => {
    const { text, isError } = await presentText([{ path: APP }], {
      checkServedPage: async () => ({
        loaded: true,
        errors: ["TypeError: game is undefined"],
      }),
    });

    expect(isError).toBe(true);
    expect(text).toContain("its page threw as it loaded");
    expect(text).toContain("TypeError: game is undefined");
    expect(sent).not.toHaveBeenCalled();
  });

  it("says its page loaded without errors when the browser saw none", async () => {
    const checked: string[] = [];
    const { text, isError } = await presentText([{ path: APP }], {
      checkServedPage: async (url: string) => {
        checked.push(url);
        return { loaded: true, errors: [] };
      },
    });

    expect(isError).toBe(false);
    expect(checked).toEqual([APP]);
    expect(text).toContain(
      `${APP} answered (HTTP 200) and its page loaded without errors.`
    );
  });

  it("asks nothing of a remote URL: it is taken as given", async () => {
    const checkServedPage = vi.fn();
    const { text, isError } = await presentText(
      [{ path: "https://example.invalid/app" }],
      { checkServedPage }
    );

    expect(isError).toBe(false);
    expect(text).toContain("[artifact] https://example.invalid/app");
    expect(checkServedPage).not.toHaveBeenCalled();
  });
});

describe("offer_session", () => {
  // "app" is a bot's own chat in the app, "linked" a bot that lives in a chat
  // app, "session" no bot at all.
  const server = () =>
    new McpAgentToolsServer({
      skillsService: {} as never,
      enabledToolsets: () => new Set<string>(),
      workspacePath: () => null,
      botIdForSession: (sessionId: string) =>
        sessionId === "session" ? null : "bot-1",
      isAppBotChat: (sessionId: string) => sessionId === "app",
    } as never) as unknown as {
      listTools: (session?: string) => { name: string }[];
      executeTool: (
        name: string,
        args: Record<string, unknown>,
        session?: string
      ) => Promise<{ isError?: boolean; content: { text?: string }[] }>;
    };
  const listed = (session: string) =>
    server()
      .listTools(session)
      .some((tool) => tool.name === "offer_session");

  it("is offered only in a bot's own chat in the app", () => {
    expect(listed("app")).toBe(true);
    expect(listed("linked")).toBe(false);
    expect(listed("session")).toBe(false);
  });

  it("answers the bot, and refuses a caller it is not listed for", async () => {
    const args = { title: "Landing page", prompt: "Build me a landing page" };
    const ok = await server().executeTool("offer_session", args, "app");
    expect(ok.isError).not.toBe(true);
    expect(ok.content[0]?.text).toContain("button");
    const refused = await server().executeTool("offer_session", args, "linked");
    expect(refused.isError).toBe(true);
  });
});
