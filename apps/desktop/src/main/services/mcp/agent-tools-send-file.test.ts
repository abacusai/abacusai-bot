/**
 * `send_chat_message` with an attachment: the file must exist, sit in the
 * workspace outside any credential store, fit the cap, and go through the file
 * lane with the message as its caption.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

let dir: string;
let outside: string;
const send = vi.fn(async () => undefined);
const sendFile = vi.fn(async () => undefined);

const server = (): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["messaging"]),
    workspacePath: () => dir,
    messaging: {
      runningPlatforms: () => ["whatsapp"],
      listChats: () => [],
      send,
      readMessages: async () => [],
      sendFile,
    },
  } as never);

const call = async (
  args: Record<string, unknown>,
  tool = "send_chat_message"
): Promise<string> => {
  const result = await (
    server() as unknown as {
      executeTool: (
        name: string,
        args: Record<string, unknown>
      ) => Promise<{ content: { text?: string }[] }>;
    }
  ).executeTool(tool, args);

  return result.content.map((part) => part.text ?? "").join("\n");
};

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "send-file-")));
  outside = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "send-file-out-"))
  );
  send.mockClear();
  sendFile.mockClear();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** The path the file lane was handed on its last call. */
const sentPath = (): string =>
  (sendFile.mock.calls.at(-1) as unknown as string[])[2];

/** The file the file lane was handed on its last call, and what it held. */
const sentFile = (): { name: string; contents: string } => {
  const sent = sentPath();
  return {
    name: path.basename(sent),
    contents: fs.readFileSync(sent, "utf8"),
  };
};

describe("sending a file", () => {
  it("delivers through the file lane with the message as caption", async () => {
    const file = path.join(dir, "report.pdf");
    fs.writeFileSync(file, "pdf bytes");

    const text = await call({
      platform: "whatsapp",
      to: "Baba",
      message: "the report",
      attachment_path: file,
    });

    expect(sendFile).toHaveBeenCalledWith(
      "whatsapp",
      "Baba",
      expect.any(String),
      "the report"
    );
    // A private copy of the bytes checked, never the path the model named.
    expect(sentPath()).not.toBe(file);
    expect(sentFile()).toEqual({ name: "report.pdf", contents: "pdf bytes" });
    expect(send).not.toHaveBeenCalled();
    expect(text).toContain("Sent the file");
  });

  it("allows a file with no caption, but not a call with neither", async () => {
    const file = path.join(dir, "photo.jpg");
    fs.writeFileSync(file, "jpg");

    await call({ platform: "whatsapp", to: "Baba", attachment_path: file });
    expect(sendFile).toHaveBeenCalledWith(
      "whatsapp",
      "Baba",
      expect.any(String),
      undefined
    );

    const text = await call({ platform: "whatsapp", to: "Baba" });
    expect(text).toContain("no message");
  });

  it("refuses a path that does not exist, naming it", async () => {
    const text = await call({
      platform: "whatsapp",
      to: "Baba",
      attachment_path: path.join(dir, "missing.png"),
    });

    expect(sendFile).not.toHaveBeenCalled();
    expect(text).toContain("No file at");
  });

  it("refuses a file over the cap with both sizes in the answer", async () => {
    const file = path.join(dir, "huge.bin");
    fs.writeFileSync(file, Buffer.alloc(26 * 1024 * 1024));

    const text = await call({
      platform: "whatsapp",
      to: "Baba",
      attachment_path: file,
    });

    expect(sendFile).not.toHaveBeenCalled();
    expect(text).toContain("26MB");
    expect(text).toContain("25MB");
  });

  it("refuses a file outside the workspace", async () => {
    const file = path.join(outside, "notes.txt");
    fs.writeFileSync(file, "private");

    const text = await call({
      platform: "whatsapp",
      to: "Baba",
      attachment_path: file,
    });

    expect(sendFile).not.toHaveBeenCalled();
    expect(text).toContain("only files in the workspace");
  });

  it("refuses a symlink in the workspace that leads out of it", async () => {
    fs.writeFileSync(path.join(outside, "notes.txt"), "private");
    const link = path.join(dir, "notes.txt");
    fs.symlinkSync(path.join(outside, "notes.txt"), link);

    const text = await call({
      platform: "whatsapp",
      to: "Baba",
      attachment_path: link,
    });

    expect(sendFile).not.toHaveBeenCalled();
    expect(text).toContain("only files in the workspace");
  });

  it("never sends a credential store, even one inside the workspace", async () => {
    const appHome = path.join(dir, "app-home");
    fs.mkdirSync(appHome);
    fs.writeFileSync(path.join(appHome, "config.json"), '{"key":"sk-test"}');
    vi.stubEnv("ABACUSAI_BOT_HOME", appHome);

    const text = await call({
      platform: "whatsapp",
      to: "Baba",
      attachment_path: path.join(appHome, "config.json"),
    });

    expect(sendFile).not.toHaveBeenCalled();
    expect(text).toContain("credential store");
  });

  it("drops an attachment the per-platform tool does not declare", async () => {
    const file = path.join(dir, "report.pdf");
    fs.writeFileSync(file, "pdf bytes");

    await call(
      { to: "Baba", message: "hello", attachment_path: file },
      "send_whatsapp_message"
    );

    expect(sendFile).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("whatsapp", "Baba", "hello");
  });
});
