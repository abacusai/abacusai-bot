// @vitest-environment jsdom
/**
 * What a failed Discord send logs about the page, run against a real DOM.
 *
 * A send whose composer kept its text after Enter logged nothing, so why it
 * did not go could not be told apart. It logs the page's shape now, and those
 * logs are synced: the shape is structural (a dialog over the page, a locked
 * or unfocused composer, the window's focus), never the text typed, the
 * messages around it or who the chat is with.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {}, net: {} }));
vi.mock("../../bring-to-front", () => ({}));
vi.mock("./messaging-config-service", () => ({}));

const { DiscordWebConnector } = await import("./discord-web-connector");

const SECRET_TEXT = "meet me at the usual place";
const CONTACT = "Someone Particular";

const failureLog = async (): Promise<string> => {
  const logs: string[] = [];
  const connector = new DiscordWebConnector({
    onMessage: () => {},
    onState: () => {},
    onLog: (line) => logs.push(line),
  }) as unknown as {
    window: unknown;
    logSendFailure: (what: string) => Promise<void>;
  };
  connector.window = {
    isDestroyed: () => false,
    // Evaluated in this DOM, as the page would run it.
    webContents: {
      executeJavaScript: async (code: string): Promise<unknown> =>
        Function(`return ${code}`)(),
    },
  };
  await connector.logSendFailure("kept the text after Enter");
  return logs.join("\n");
};

describe("a failed Discord send's page log", () => {
  it("says what is on the page, and nothing anyone wrote", async () => {
    window.history.replaceState({}, "", "/channels/@me/123456789");
    document.body.innerHTML = `
      <ol><li id="chat-messages-1">${CONTACT}: hello there</li>
          <li id="chat-messages-2">${CONTACT}: are you around?</li></ol>
      <div role="dialog" aria-modal="true">Verify your phone number</div>
      <form><div role="textbox" data-slate-editor="true" contenteditable="true"
        aria-label="Message @${CONTACT}">${SECRET_TEXT}</div>
        <button type="submit" disabled></button></form>`;

    const line = await failureLog();
    const shape = JSON.parse(line.slice(line.indexOf("page ") + 5)) as Record<
      string,
      unknown
    >;

    expect(shape).toMatchObject({
      page: "dm",
      composer: {
        length: SECRET_TEXT.length,
        editable: true,
        disabled: false,
        focused: false,
      },
      submitButton: { disabled: true },
      dialogs: 1,
      messages: 2,
    });
    expect(line).not.toContain(SECRET_TEXT);
    expect(line).not.toContain(CONTACT);
    expect(line).not.toContain("123456789");
    expect(line).not.toContain("Verify");
  });
});
