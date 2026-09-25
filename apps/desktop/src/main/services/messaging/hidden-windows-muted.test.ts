/**
 * The chat connectors' windows are hidden and driven, not looked at.
 *
 * Each one loads a real web app (WhatsApp Web, Telegram Web, Discord) and
 * each of those plays a sound when a message arrives. With the window hidden
 * that sound has no window behind it to explain it: the user hears a
 * notification from nowhere, for a message the app is about to tell them about
 * itself. So every window is muted where it is built.
 *
 * Asserted against the source because the alternative is booting Electron for
 * four `new BrowserWindow` calls. What matters is the invariant: no window is
 * built without being muted, and that is what a new connector would break.
 */
import fs from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

const CONNECTORS = [
  "whatsapp-web-connector.ts",
  "telegram-web-connector.ts",
  "discord-web-connector.ts",
];

const sourceOf = (file: string): string =>
  fs.readFileSync(path.join(import.meta.dirname, file), "utf8");

describe("every hidden chat window", () => {
  it.each(CONNECTORS)("is muted as many times as %s builds one", (file) => {
    const source = sourceOf(file);
    const built = source.split("new BrowserWindow(").length - 1;
    const muted = source.split("setAudioMuted(true)").length - 1;

    expect(built).toBeGreaterThan(0);
    expect(muted).toBe(built);
  });

  it("is muted in every connector, not just the one that was reported", () => {
    // The report named WhatsApp. Telegram and Discord load web apps that make
    // the same noise for the same reason, and a fix for one of three would
    // have looked complete until the next message arrived on another.
    for (const file of CONNECTORS) {
      expect(sourceOf(file)).toContain("setAudioMuted(true)");
    }
  });
});
