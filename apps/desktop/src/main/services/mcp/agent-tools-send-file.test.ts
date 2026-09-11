/**
 * `send_chat_message` with an attachment: the file must exist, fit the cap,
 * and go through the file lane with the message as its caption.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

let dir: string;
const send = vi.fn(async () => undefined);
const sendFile = vi.fn(async () => undefined);

const server = (): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["messaging"]),
    workspacePath: () => null,
    messaging: {
      runningPlatforms: () => ["whatsapp"],
      listChats: () => [],
      send,
      readMessages: async () => [],
      sendFile,
    },
  } as never);

const call = async (args: Record<string, unknown>): Promise<string> => {
  const result = await (
    server() as unknown as {
      executeTool: (
        name: string,
        args: Record<string, unknown>
      ) => Promise<{ content: { text?: string }[] }>;
    }
  ).executeTool("send_chat_message", args);

  return result.content.map((part) => part.text ?? "").join("\n");
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "send-file-"));
  send.mockClear();
  sendFile.mockClear();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

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
      file,
      "the report"
    );
    expect(send).not.toHaveBeenCalled();
    expect(text).toContain("Sent the file");
  });

  it("allows a file with no caption, but not a call with neither", async () => {
    const file = path.join(dir, "photo.jpg");
    fs.writeFileSync(file, "jpg");

    await call({ platform: "whatsapp", to: "Baba", attachment_path: file });
    expect(sendFile).toHaveBeenCalledWith("whatsapp", "Baba", file, undefined);

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
});
