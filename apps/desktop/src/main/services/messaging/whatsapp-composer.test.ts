/**
 * Opening a chat's message box, and what is said when it does not appear.
 *
 * The report: a user linked WhatsApp, asked the bot to message himself, and
 * was told WhatsApp "needs to be set up on your phone first — scan a QR code".
 * It was linked; the QR had been scanned a minute earlier. The chat had opened
 * and the composer simply had not mounted yet, and the only thing the tool
 * said about that was "The message box did not open" — so the model invented
 * the rest.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) },
  shell: { openExternal: async () => undefined },
}));

const { WhatsAppWebConnector } = await import("./whatsapp-web-connector");

/** The connector with its two page calls stubbed; no Electron involved. */
const connectorWith = (
  composerAnswers: Array<{
    ok: boolean;
    error?: string;
    x?: number;
    y?: number;
  }>
): {
  openComposer: (chatId: string) => Promise<{ x: number; y: number }>;
  opens: () => number;
  logs: string[];
} => {
  const logs: string[] = [];
  const connector = new WhatsAppWebConnector({
    onMessage: () => {},
    onState: () => {},
    onLog: (line: string) => logs.push(line),
  } as never);

  let opens = 0;
  const queue = [...composerAnswers];
  const internals = connector as unknown as {
    openChat: (chatId: string) => Promise<{ ok: boolean; error?: string }>;
    run: (script: string, args: unknown) => Promise<unknown>;
    openComposer: (chatId: string) => Promise<{ x: number; y: number }>;
  };
  internals.openChat = async () => {
    opens += 1;
    return { ok: true };
  };
  internals.run = async (script: string) =>
    // The opened-chat identity gate runs its own script before the composer
    // wait; the harness answers it "right chat" so composer behavior stays
    // the thing under test.
    script.includes("just read the bar")
      ? { ok: true, bar: "wanted chat" }
      : (queue.shift() ?? { ok: false, error: "drained" });

  return {
    openComposer: (chatId) => internals.openComposer(chatId),
    opens: () => opens,
    logs,
  };
};

describe("one driver at a time", () => {
  /**
   * The inbound sweep runs every five seconds and a send waits seconds for a
   * composer, so they overlap constantly — and the sweep's self lookup types
   * into the search box, which replaces whatever conversation the send just
   * opened. The send then waits out its timeout on a chat no longer on screen.
   */
  it("runs page work in the order it was asked for, never at once", async () => {
    const connector = new WhatsAppWebConnector({
      onMessage: () => {},
      onState: () => {},
      onLog: () => {},
    } as never);

    const order: string[] = [];
    let running = 0;
    let overlapped = false;
    const internals = connector as unknown as {
      serialize: <T>(task: () => Promise<T>) => Promise<T>;
    };

    const work = (name: string, ms: number) =>
      internals.serialize(async () => {
        running += 1;
        if (running > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, ms));
        order.push(name);
        running -= 1;
      });

    await Promise.all([work("send", 30), work("sweep", 1), work("read", 1)]);

    expect(overlapped).toBe(false);
    expect(order).toEqual(["send", "sweep", "read"]);
  });

  it("lets the queue carry on after one of them fails", async () => {
    // A failed send belongs to its caller; the sweep behind it still runs.
    const connector = new WhatsAppWebConnector({
      onMessage: () => {},
      onState: () => {},
      onLog: () => {},
    } as never);
    const internals = connector as unknown as {
      serialize: <T>(task: () => Promise<T>) => Promise<T>;
    };

    const failed = internals
      .serialize(async () => {
        throw new Error("send blew up");
      })
      .catch((e: Error) => e.message);
    const after = internals.serialize(async () => "ran anyway");

    expect(await failed).toBe("send blew up");
    expect(await after).toBe("ran anyway");
  });
});

describe("waiting for the message box", () => {
  it("uses it as soon as it is there", async () => {
    const { openComposer, opens } = connectorWith([{ ok: true, x: 10, y: 20 }]);

    await expect(openComposer("Alex 2")).resolves.toEqual({
      x: 10,
      y: 20,
    });
    expect(opens()).toBe(1);
  });

  it("opens the chat again when the box has not mounted yet", async () => {
    // The minutes after a link: the chat list is already there — it is what
    // the row was found in — but the conversation pane has not finished
    // mounting, so the first wait times out on a chat that is perfectly fine.
    const { openComposer, opens, logs } = connectorWith([
      { ok: false, error: "The message box did not open." },
      { ok: true, x: 10, y: 20 },
    ]);

    await expect(openComposer("Alex 2")).resolves.toEqual({
      x: 10,
      y: 20,
    });
    expect(opens()).toBe(2);
    expect(logs.join("\n")).toMatch(/trying once more/i);
  });

  it("gives up after the second try rather than looping", async () => {
    const { openComposer, opens } = connectorWith([
      { ok: false, error: "The message box did not open." },
      { ok: false, error: "The message box did not open." },
    ]);

    await expect(openComposer("Alex 2")).rejects.toThrow();
    expect(opens()).toBe(2);
  });

  it("says the account is linked, so nobody is sent to scan a QR", async () => {
    const { openComposer } = connectorWith([
      { ok: false, error: "The message box did not open." },
      { ok: false, error: "The message box did not open." },
    ]);

    const error = await openComposer("Alex 2").catch((e: Error) => e);

    expect(String(error)).toMatch(/whatsapp is linked/i);
    expect(String(error)).toMatch(/do not tell the user to set up whatsapp/i);
    expect(String(error)).toMatch(/nothing was sent/i);
    // The chat it failed on, so the model can say which send did not go.
    expect(String(error)).toContain("Alex 2");
  });

  it("does not retry a chat that could not be found", async () => {
    // Asking twice does not make an unknown contact known, and the caller
    // already has a better error for it.
    const logs: string[] = [];
    const connector = new WhatsAppWebConnector({
      onMessage: () => {},
      onState: () => {},
      onLog: (line: string) => logs.push(line),
    } as never);
    let opens = 0;
    const internals = connector as unknown as {
      openChat: () => Promise<{ ok: boolean; error?: string }>;
      run: () => Promise<unknown>;
      openComposer: (chatId: string) => Promise<{ x: number; y: number }>;
    };
    internals.openChat = async () => {
      opens += 1;
      return { ok: false, error: 'No WhatsApp chat matched "Nobody".' };
    };
    internals.run = async () => ({ ok: true, x: 1, y: 1 });

    await expect(internals.openComposer("Nobody")).rejects.toThrow(/Nobody/);
    expect(opens).toBe(1);
  });
});
