import type { SessionOwner } from "@abacus-ai/contract/contracts";
import { describe, expect, it } from "vitest";

import { CHANNEL_PLATFORM } from "../channels/channel-service";
import { BOT_ASK_PLATFORM } from "./bot-ask";
import { isRemoteSenderOwner } from "./sender-kind";

const owner = (
  role: SessionOwner["role"],
  platform: string | null
): SessionOwner => ({ kind: "bot", botId: "b", role, key: "k", platform });

describe("a remote sender's chat", () => {
  it.each([
    ["a WhatsApp contact", owner("sender", "whatsapp"), true],
    ["a Telegram contact", owner("sender", "telegram"), true],
    ["a channel turn", owner("sender", CHANNEL_PLATFORM), false],
    ["another bot's ask", owner("sender", BOT_ASK_PLATFORM), false],
    ["the bot's own chat", owner("forever", null), false],
    ["a routine", owner("routine", null), false],
    ["no owner", null, false],
  ])("%s", (_kind, who, remote) => {
    expect(isRemoteSenderOwner(who)).toBe(remote);
  });
});
