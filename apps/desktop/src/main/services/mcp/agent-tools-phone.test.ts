/**
 * The hosted WhatsApp lane's chat has no pane: what its tools say and what
 * `present_deliverable` and `serve` do there. Every other session and bot is
 * an app chat and must read and behave exactly as before; mcp-wire.test.ts
 * pins those listings byte for byte, and this file checks the phone seam
 * leaves them alone.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { WHATSAPP_CHANNEL } from "@abacus-ai/agent/channel";
import { declaredMedia } from "@abacus-ai/agent/send-media";
import {
  PHONE_EXCLUDED_MCP_TOOLS,
  PHONE_MCP_TOOLS,
} from "@abacus-ai/agent/tool-policy";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaStore } from "../messaging/media-store";
import { Vault } from "../vault/vault-tools";
import { McpAgentToolsServer } from "./mcp-agent-tools-server";
import { McpBrowserServer } from "./mcp-browser-server";
import { McpDeviceServer } from "./mcp-device-server";
import type { McpToolListing } from "./mcp-http-server";
import { AGENT_TOOL_NAMES } from "./tools";

const sent = vi.fn();

vi.mock("#main/rpc/emit", () => ({
  emitHostEvent: (payload: unknown) => sent(payload),
}));

const PHONE = "phone-session";
/** Pane ideas a phone user cannot act on. */
const PANE_WORDING = /\bpanes?\b|preview pane|browser pane|on screen/i;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([4, 0, 0, 0]),
  Buffer.from("WEBPVP8 "),
]);
const SHOT = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7]);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "phone-deliver-"));
fs.writeFileSync(path.join(workspace, "love.pdf"), "%PDF-1.7 love");
fs.writeFileSync(path.join(workspace, "notes.docx"), "PK\u0003\u0004 notes");
fs.writeFileSync(path.join(workspace, "chart.png"), PNG);
fs.writeFileSync(path.join(workspace, "sky.webp"), WEBP);
fs.writeFileSync(path.join(workspace, "clip.mp4"), "not for the chat");
fs.writeFileSync(path.join(workspace, "page.htm"), "<p>hi</p>");
fs.writeFileSync(path.join(workspace, "empty.pdf"), "");
// A PNG past the 5 MB a picture may be.
fs.writeFileSync(
  path.join(workspace, "huge.png"),
  Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)])
);
fs.mkdirSync(path.join(workspace, "site"));
// A way out of the workspace, a pipe, and a credential store.
const outside = fs.mkdtempSync(path.join(os.homedir(), ".phone-outside-"));
fs.writeFileSync(path.join(outside, "secret.pdf"), "%PDF secret");
fs.symlinkSync(
  path.join(outside, "secret.pdf"),
  path.join(workspace, "linked.pdf")
);
execFileSync("mkfifo", [path.join(workspace, "pipe.txt")]);
const appHome = path.join(workspace, "app-home");
fs.mkdirSync(appHome);
fs.writeFileSync(path.join(appHome, "config.json"), '{"key":"secret"}');
const savedHome = process.env.ABACUSAI_BOT_HOME;
process.env.ABACUSAI_BOT_HOME = appHome;
fs.writeFileSync(path.join(workspace, "site", "index.html"), "<h1>Hi</h1>");

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  if (savedHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = savedHome;
});

let store: MediaStore;
const screenshot = vi.fn(
  async (_url: string, _origin: string, sessionId: string) =>
    store.put(sessionId, SHOT)
);

const server = (phoneSeam = true): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["todo", "memory", "cronjob", "pdf"]),
    workspacePath: () => workspace,
    botIdForSession: (session: string) =>
      session === "bot-session" ? "bot-1" : null,
    ...(phoneSeam
      ? {
          channelForSession: (session: string) =>
            session === PHONE ? WHATSAPP_CHANNEL : null,
          chatMedia: () => ({
            keep: (sessionId: string, data: Buffer, filename: string) =>
              store.putFile(sessionId, data, filename),
            screenshot,
          }),
        }
      : {}),
  } as never);

const listTools = (
  target: McpAgentToolsServer,
  session?: string
): McpToolListing[] =>
  (
    target as unknown as { listTools: (s?: string) => McpToolListing[] }
  ).listTools(session);

/** One server per test: `serve` and `present_deliverable` share its state. */
let shared: McpAgentToolsServer;

const call = async (
  name: string,
  args: Record<string, unknown>,
  session = PHONE
): Promise<{ text: string; isError: boolean }> => {
  const result = (await shared.executeTool(name, args, session)) as {
    content: Array<{ text?: string }>;
    isError?: boolean;
  };
  return {
    text: result.content.map((part) => part.text ?? "").join("\n"),
    isError: result.isError === true,
  };
};

beforeEach(() => {
  sent.mockClear();
  screenshot.mockClear();
  store = new MediaStore();
  shared = server();
});

describe("the phone's tools", () => {
  it("decides every built-in tool that reaches the loop: allowed or excluded, never neither", () => {
    const listed = (target: unknown): string[] =>
      (target as { listTools: () => McpToolListing[] })
        .listTools()
        .map((tool) => tool.name);
    const vault = new Vault({
      client: { maybeAvailable: () => true } as never,
      deliver: () => {},
    } as never);
    const builtins = [
      ...AGENT_TOOL_NAMES,
      // The browser server's own tools reach the sub-agent (`browser_*`);
      // the rest, the vault's among them, reach the loop.
      ...listed(new McpBrowserServer({ target: () => null, vault })).filter(
        (name) => !name.startsWith("browser_")
      ),
      ...listed(new McpDeviceServer()),
    ];
    const allowed = new Set(PHONE_MCP_TOOLS.builtin);
    const excluded = new Set(Object.keys(PHONE_EXCLUDED_MCP_TOOLS));
    expect(builtins).toEqual(
      expect.arrayContaining([
        "vault_items",
        "vault_request",
        "payment_approval",
      ])
    );
    for (const name of builtins)
      expect(
        allowed.has(name) !== excluded.has(name),
        `${name}: name it in PHONE_MCP_TOOLS or PHONE_EXCLUDED_MCP_TOOLS`
      ).toBe(true);
    // Nothing named that the app does not serve.
    for (const name of [...allowed, ...excluded])
      expect(builtins, name).toContain(name);
  });

  it("never mention a pane, in a description or a schema", () => {
    const listed = listTools(server(), PHONE);
    expect(listed.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["serve", "present_deliverable"])
    );
    for (const tool of listed) {
      expect(tool.description, tool.name).not.toMatch(PANE_WORDING);
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(
        PANE_WORDING
      );
    }
    const present = listed.find((tool) => tool.name === "present_deliverable");
    expect(present?.description).toContain("into this chat");
    expect(present?.description).not.toMatch(
      /attachment_path|send_chat_message/
    );
  });

  it("the browser sub-agent's tools never mention a pane either", () => {
    const browser = new McpBrowserServer({ target: () => null });
    const listed = (
      browser as unknown as { listTools: () => McpToolListing[] }
    ).listTools();
    for (const tool of listed)
      expect(tool.description, tool.name).not.toMatch(PANE_WORDING);
  });

  it("leaves every app session's and bot's listing as it was", () => {
    for (const session of [undefined, "ui-session", "bot-session"])
      expect(listTools(server(), session)).toEqual(
        listTools(server(false), session)
      );
    const app = listTools(server(), "ui-session").find(
      (tool) => tool.name === "present_deliverable"
    );
    expect(app?.description).toContain(
      "the first one also opens in the preview pane"
    );
  });
});

describe("present_deliverable on the phone", () => {
  it("sends a pdf and a docx as documents and an image as a picture, and opens no pane", async () => {
    const { text, isError } = await call("present_deliverable", {
      items: [
        { path: "love.pdf" },
        { path: "notes.docx" },
        { path: "chart.png" },
        { path: "sky.webp" },
      ],
      summary: "A one-pager on love",
    });

    expect(isError).toBe(false);
    expect(text).toContain("Sending 4 items to this chat with your answer");
    expect(text).not.toMatch(PANE_WORDING);
    const kinds = declaredMedia(text).map((id) => {
      const media = store.resolve(id, PHONE);
      if (media.ok === false) return media.reason;
      return media.kind === "document" ? media.filename : media.mimeType;
    });
    expect(kinds).toEqual([
      "love.pdf",
      "notes.docx",
      "image/png",
      "image/webp",
    ]);
    // Held for the phone's session only.
    expect(store.resolve(declaredMedia(text)[0]!, "ui-session").ok).toBe(false);
    expect(sent).not.toHaveBeenCalled();
  });

  it("sends a screenshot of a page it served, and says the phone cannot open it", async () => {
    const served = await call("serve", { action: "start", directory: "site" });
    const url = /at (http:\/\/[^\s]+)/.exec(served.text)![1]!;
    try {
      const { text, isError } = await call("present_deliverable", {
        items: [{ path: url, label: "Site" }],
      });

      expect(isError).toBe(false);
      expect(screenshot).toHaveBeenCalledWith(url, new URL(url).origin, PHONE);
      expect(text).toContain("a screenshot of the page");
      expect(text).toContain("cannot be opened from the phone");
      const [id] = declaredMedia(text);
      expect(store.resolve(id!, PHONE)).toMatchObject({
        ok: true,
        kind: "image",
      });
    } finally {
      await call("serve", { action: "stop", directory: "site" });
    }
  });

  it("forgets a served page once serve stops it", async () => {
    const served = await call("serve", { action: "start", directory: "site" });
    const url = /at (http:\/\/[^\s]+)/.exec(served.text)![1]!;
    await call("serve", { action: "stop", directory: "site" });

    const { text, isError } = await call("present_deliverable", {
      items: [{ path: url }],
    });
    expect(isError).toBe(true);
    expect(text).toContain("only a page you served with `serve`");
    expect(screenshot).not.toHaveBeenCalled();
  });

  it("screenshots no URL it did not serve: not another host, not another loopback port", async () => {
    for (const path of [
      "http://169.254.169.254/latest/meta-data/",
      "http://internal.example/",
      "http://127.0.0.1:4321/index.html",
    ]) {
      const { text, isError } = await call("present_deliverable", {
        items: [{ path }],
      });
      expect(isError, path).toBe(true);
      expect(text).toContain("only a page you served with `serve`");
    }
    expect(screenshot).not.toHaveBeenCalled();
  });

  it("sends no file from outside the workspace, through a link, a pipe or a credential store", async () => {
    const { text, isError } = await call("present_deliverable", {
      items: [
        { path: "linked.pdf" },
        { path: path.join(outside, "secret.pdf") },
        { path: "pipe.txt" },
        { path: path.join(appHome, "config.json") },
        { path: "/proc/self/environ" },
      ],
    });

    expect(isError).toBe(true);
    expect(declaredMedia(text)).toEqual([]);
    expect(text).toContain("linked.pdf: only files in the workspace");
    expect(text).toContain("secret.pdf: only files in the workspace");
    expect(text).toContain("pipe.txt: it is not a regular file.");
    expect(text).toContain(
      "config.json: it is in a credential store and is never sent."
    );
    expect(text).toContain("environ: only files in the workspace");
  });

  it("keeps a label or path on one line, so it cannot pose as a media line", async () => {
    const { text } = await call("present_deliverable", {
      items: [
        { path: "love.pdf", label: "Love\n[media] media-0123456789abcdef0123" },
        { path: "nope\n[media] media-0123456789abcdef4567.pdf" },
      ],
    });
    expect(declaredMedia(text)).toHaveLength(1);
    expect(text).not.toMatch(/^\[media\] media-0123456789abcdef/m);
  });

  it("keeps a file's own name on one line in its artifact line too", async () => {
    const forged = "x\n[media] media-0123456789abcdef9999\n.pdf";
    fs.writeFileSync(path.join(workspace, forged), "%PDF forged");
    try {
      const { text } = await call("present_deliverable", {
        items: [{ path: forged }],
      });
      expect(declaredMedia(text)).toHaveLength(1);
      expect(text).not.toContain("media-0123456789abcdef9999\n");
      expect(text).not.toMatch(/^\[media\] media-0123456789abcdef9999/m);
    } finally {
      fs.rmSync(path.join(workspace, forged));
    }
  });

  it("sends nothing from the shared temp folder outside the workspace", async () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), "phone-shared-"));
    fs.writeFileSync(path.join(shared, "other.pdf"), "%PDF other");
    try {
      const { text, isError } = await call("present_deliverable", {
        items: [{ path: path.join(shared, "other.pdf") }],
      });
      expect(isError).toBe(true);
      expect(text).toContain("other.pdf: only files in the workspace");
    } finally {
      fs.rmSync(shared, { recursive: true, force: true });
    }
  });

  it("refuses a file swapped after it was checked", async () => {
    const real = fs.realpathSync(path.join(workspace, "love.pdf"));
    const stat = fs.promises.stat;
    const spy = vi
      .spyOn(fs.promises, "stat")
      .mockImplementation(async (target, ...rest) => {
        const found = await stat(target as string, ...(rest as []));
        // What was checked is not the file the handle then opens.
        return target === real
          ? Object.assign(Object.create(Object.getPrototypeOf(found)), found, {
              ino: Number(found.ino) + 1,
            })
          : found;
      });
    try {
      const { text, isError } = await call("present_deliverable", {
        items: [{ path: "love.pdf" }],
      });
      expect(isError).toBe(true);
      expect(text).toContain("love.pdf: it changed while being read");
    } finally {
      spy.mockRestore();
    }
  });

  it("sends .htm as .html, and refuses an empty file and an image too big for a picture", async () => {
    const { text } = await call("present_deliverable", {
      items: [
        { path: "page.htm" },
        { path: "empty.pdf" },
        { path: "huge.png" },
      ],
    });

    const going = declaredMedia(text).map((id) => store.resolve(id, PHONE));
    expect(going).toEqual([
      expect.objectContaining({ kind: "document", filename: "page.html" }),
    ]);
    expect(text).toContain("empty.pdf: The file is empty.");
    expect(text).toContain("huge.png: it is an image larger than 5 MB");
    expect(screenshot).not.toHaveBeenCalled();
  });

  it("says plainly what cannot go, and fails when nothing can", async () => {
    const mixed = await call("present_deliverable", {
      items: [{ path: "love.pdf" }, { path: "clip.mp4" }],
    });
    expect(mixed.isError).toBe(false);
    expect(declaredMedia(mixed.text)).toHaveLength(1);
    expect(mixed.text).toMatch(/Not sent:\n- clip\.mp4: The chat takes only/);
    expect(mixed.text).toContain("Convert it to one of them (a PDF, say)");

    const none = await call("present_deliverable", {
      items: [{ path: "clip.mp4" }],
    });
    expect(none.isError).toBe(true);
    expect(declaredMedia(none.text)).toEqual([]);
  });

  it("is unchanged in an app session: the first item goes to the preview pane", async () => {
    const { text } = await call(
      "present_deliverable",
      { items: [{ path: "love.pdf" }] },
      "ui-session"
    );
    expect(text).toContain("was sent to the preview pane");
    expect(declaredMedia(text)).toEqual([]);
    expect(sent).toHaveBeenCalledTimes(1);
  });
});

describe("serve on the phone", () => {
  it("says the URL opens on this computer only and that a screenshot goes instead", async () => {
    const { text, isError } = await call("serve", {
      action: "start",
      directory: "site",
    });
    await call("serve", { action: "stop", directory: "site" });

    expect(isError).toBe(false);
    expect(text).toContain("the user cannot open it from their phone");
    expect(text).toContain("screenshot");
    expect(text).not.toMatch(PANE_WORDING);
  });
});

describe("media held for an answer", () => {
  it("is never evicted for room, and no more than 48 MB waits for one answer", () => {
    const held = new MediaStore();
    const pdf = (mb: number) =>
      Buffer.concat([Buffer.from("%PDF"), Buffer.alloc(mb * 1024 * 1024)]);
    const kept = [1, 2, 3].map(
      () => held.putFile("s", pdf(15), "a.pdf") as { id: string }
    );
    expect(held.putFile("s", pdf(15), "b.pdf")).toEqual({
      reason: expect.stringContaining("more than 48 MB"),
    });
    // Screenshots past the store's room evict each other, never the files.
    const jpeg = Buffer.concat([SHOT, Buffer.alloc(4 * 1024 * 1024)]);
    for (let i = 0; i < 10; i += 1) held.put("s", jpeg);
    for (const { id } of kept)
      expect(held.resolve(id, "s")).toMatchObject({ ok: true });
    // Sent: evictable again.
    for (const { id } of kept) held.unpin(id, "s");
    for (let i = 0; i < 10; i += 1) held.put("s", jpeg);
    expect(held.resolve(kept[0]!.id, "s")).toMatchObject({ ok: false });
  });
});

describe("a served page's screenshot for the chat", () => {
  /** A browser whose tabs record what was done to them. */
  const browser = (options: { lands?: string; popup?: boolean } = {}) => {
    const log: string[] = [];
    const tabs = new Map<number, { owner: string; url: string }>();
    let next = 1;
    const page = (id: number) => ({
      id,
      isDestroyed: () => !tabs.has(id),
      isLoading: () => false,
      getURL: () => tabs.get(id)?.url ?? "",
      getTitle: () => "",
      loadURL: async (url: string) => {
        log.push(`load ${url}`);
        tabs.get(id)!.url = url;
        // A page that opens a popup, which joins the same owner.
        if (options.popup === true)
          tabs.set(next++, { owner: tabs.get(id)!.owner, url });
      },
      debugger: {
        isAttached: () => true,
        attach: () => {},
        sendCommand: async (method: string) => {
          log.push(method);
          return {};
        },
      },
    });
    const media = new MediaStore();
    const source = {
      candidates: () => [],
      webContents: (id: number) => (tabs.has(id) ? page(id) : null),
      materialize: async (owner: string, url: string) => {
        log.push(`open ${url}`);
        tabs.set(next, { owner, url });
        return next++;
      },
      sessionTabs: (owner: string) =>
        [...tabs]
          .filter(([, tab]) => tab.owner === owner)
          .map(([id]) => ({ id })),
      closeTab: async (_owner: string, id: number) => tabs.delete(id),
      releaseSession: () => {},
      liveOrigin: async (id: number) =>
        options.lands ?? new URL(tabs.get(id)!.url).origin,
      captureMasked: async () => ({
        data: SHOT.toString("base64"),
        mimeType: "image/jpeg" as const,
      }),
    };
    const server = new McpBrowserServer({
      target: () => source as never,
      media: () => media,
    });
    return { server, log, tabs, media };
  };

  const URL_SERVED = "http://127.0.0.1:4321/index.html";
  const ORIGIN = "http://127.0.0.1:4321";

  it("opens blank, blocks Abacus.AI's hosts, then loads; captures and closes every tab it opened", async () => {
    const { server, log, tabs, media } = browser({ popup: true });

    const shot = await server.screenshotForChat(URL_SERVED, ORIGIN, PHONE);

    expect(shot).toEqual({ id: expect.stringMatching(/^media-/) });
    expect(media.resolve((shot as { id: string }).id, PHONE)).toMatchObject({
      ok: true,
      kind: "image",
    });
    expect(log.indexOf("open about:blank")).toBe(0);
    expect(log.indexOf("Network.setBlockedURLs")).toBeLessThan(
      log.indexOf(`load ${URL_SERVED}`)
    );
    expect(tabs.size).toBe(0);
  });

  it("refuses anything but the loopback origin it was given, and a page that went elsewhere", async () => {
    for (const [url, origin] of [
      ["http://169.254.169.254/", "http://169.254.169.254"],
      [URL_SERVED, "http://127.0.0.1:9999"],
    ] as const) {
      const { server, log } = browser();
      expect(await server.screenshotForChat(url, origin, PHONE)).toEqual({
        reason: "the page could not be captured.",
      });
      expect(log).toEqual([]);
    }
    const redirected = browser({ lands: "https://elsewhere.example" });
    expect(
      await redirected.server.screenshotForChat(URL_SERVED, ORIGIN, PHONE)
    ).toEqual({ reason: "the page could not be captured." });
    expect(redirected.tabs.size).toBe(0);
  });
});
