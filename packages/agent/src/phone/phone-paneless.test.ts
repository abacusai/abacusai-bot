/**
 * The phone chat has no pane: nothing it renders for its model may send the
 * user to one. Every prompt and tool description the phone loop and its
 * browser sub-agent see is rendered here and scanned, so a pane idea added
 * anywhere on that path fails here. The MCP tools' own descriptions are
 * scanned on the desktop side (agent-tools-phone.test.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildBrowserTaskTool } from "../browser-task-tool.js";
import { browserSubAgentPrompt } from "../browser-task.js";
import { buildSendMediaTool, DeliveredMedia } from "../send-media-tool.js";
import {
  checkedDocument,
  checkedImage,
  checkedImageFile,
  declaredMedia,
  mediaLine,
} from "../send-media.js";
import { mcpToolAllowed, PHONE_MCP_TOOLS } from "../tool-policy.js";
import { createPhoneProfile } from "./phone-profile.js";
import {
  PHONE_COMPACTION_CONTINUATION_PROMPT,
  PHONE_MALFORMED_CONTINUATION_PROMPT,
} from "./phone-prompts.js";

const PANE_WORDING = /\bpanes?\b|preview pane|browser pane|on screen/i;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-paneless-"));
const saved = process.env.ABACUSAI_BOT_PHONE_DIR;

beforeAll(() => {
  process.env.ABACUSAI_BOT_PHONE_DIR = dir;
});

afterAll(() => {
  if (saved == null) delete process.env.ABACUSAI_BOT_PHONE_DIR;
  else process.env.ABACUSAI_BOT_PHONE_DIR = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("what the phone loop's model reads", () => {
  it("names no pane in its prompts, its own tools, browser_task or the browser sub-agent", () => {
    const profile = createPhoneProfile({ model: null });
    const progressTools =
      profile.browserTask?.progressTools?.(new DeliveredMedia()) ?? [];
    const rendered: Array<[string, string]> = [
      ...profile
        .systemPrompt()
        .map((text): [string, string] => ["system", text]),
      ["flush", profile.memory.flush().content],
      ["compaction", PHONE_COMPACTION_CONTINUATION_PROMPT],
      ["malformed", PHONE_MALFORMED_CONTINUATION_PROMPT],
      ...(
        [
          ...profile.tools(dir, { mediaCheck: async () => true }),
          ...progressTools,
        ] as Array<{
          name: string;
          description: string;
          parameters: unknown;
        }>
      ).flatMap((tool): Array<[string, string]> => [
        [tool.name, tool.description],
        [`${tool.name} schema`, JSON.stringify(tool.parameters)],
      ]),
      [
        "browser_task",
        buildBrowserTaskTool(
          { cwd: dir, ...profile.browserTask } as never,
          () => {}
        ).description,
      ],
      ["browser sub-agent", browserSubAgentPrompt(profile.browserTask ?? {})],
    ];

    expect(rendered.length).toBeGreaterThan(10);
    for (const [where, text] of rendered)
      expect(text, where).not.toMatch(PANE_WORDING);
  });

  it("tells the model files go into the chat with present_deliverable", () => {
    const [system] = createPhoneProfile({ model: null }).systemPrompt();
    expect(system).toContain("`present_deliverable`");
    expect(system).toMatch(/cannot be opened from the phone/);
  });

  it("opts the phone into an allowlist; a profile without one keeps every tool", () => {
    expect(createPhoneProfile({ model: null }).mcpTools).toBe(PHONE_MCP_TOOLS);
    const device = { name: "device_screenshot", builtin: true };
    const present = { name: "present_deliverable", builtin: true };
    const connector = {
      name: "abacus-connectors_gmail_search",
      builtin: false,
    };
    expect(mcpToolAllowed(PHONE_MCP_TOOLS, device)).toBe(false);
    expect(mcpToolAllowed(PHONE_MCP_TOOLS, { ...present })).toBe(true);
    expect(mcpToolAllowed(PHONE_MCP_TOOLS, connector)).toBe(true);
    for (const tool of [device, present, connector])
      expect(mcpToolAllowed(undefined, tool)).toBe(true);
  });
});

describe("media for the chat", () => {
  it("takes documents by an allowed extension, up to 16 MB", () => {
    expect(checkedDocument(Buffer.from("%PDF"), "love.pdf")).toMatchObject({
      ok: true,
      kind: "document",
      filename: "love.pdf",
    });
    expect(checkedDocument(Buffer.from("x"), "clip.mp4")).toMatchObject({
      ok: false,
    });
    expect(
      checkedDocument(Buffer.alloc(16 * 1024 * 1024 + 1), "big.pdf")
    ).toEqual({ ok: false, reason: "The file is larger than 16 MB." });
  });

  it("takes WebP only as a file handed over; a screenshot stays JPEG or PNG", () => {
    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([4, 0, 0, 0]),
      Buffer.from("WEBPVP8 "),
    ]);
    expect(checkedImageFile(webp)).toMatchObject({
      ok: true,
      mimeType: "image/webp",
    });
    expect(checkedImage(webp)).toEqual({
      ok: false,
      reason: "The data is not a JPEG or PNG image.",
    });
  });

  it("reads back exactly the media lines a result declares", () => {
    const id = "media-0123456789abcdef0123";
    expect(
      declaredMedia(
        ["Sending 1 item", mediaLine(id), "[media] /etc/passwd"].join("\n")
      )
    ).toEqual([id]);
  });
});

describe("a browser run sends an image once", () => {
  it("a second send_media of the same id in one run is a no-op that says so", async () => {
    const sent = new DeliveredMedia();
    const id = "media-0123456789abcdef0123";
    const tool = buildSendMediaTool(sent);

    expect((await tool.execute("web-1", { media: id })).content[0]!.text).toBe(
      "Sent."
    );
    const again = await tool.execute("web-2", { media: id });
    expect(again.content[0]!.text).toBe(
      "This run already sent it; not sent again."
    );
    expect(again.isError).toBeUndefined();
  });

  it("the loop's own send_media never claims a send: the chat dedupes once it has delivered", async () => {
    const id = "media-0123456789abcdef0123";
    const loop = buildSendMediaTool();
    for (const call of ["toolu_1", "toolu_2"])
      expect((await loop.execute(call, { media: id })).content[0]!.text).toBe(
        "Sent."
      );
  });

  it("remembers at most 1,000 ids, oldest out first", () => {
    const sent = new DeliveredMedia();
    for (let i = 0; i < 1_001; i += 1)
      sent.add(`media-${i.toString(16).padStart(16, "0")}`);
    expect(sent.list()).toHaveLength(1_000);
    expect(sent.has("media-0000000000000000")).toBe(false);
  });
});
