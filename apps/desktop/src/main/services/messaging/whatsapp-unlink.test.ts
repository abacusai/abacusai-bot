/**
 * Unlink means the number is gone.
 *
 * The report: a user wanted to change the WhatsApp number on this computer.
 * Unlink only closed the window, the login stayed in its partition, and every
 * Connect signed the old number back in with no QR to scan.
 *
 * Pinned here: Unlink ends the session on WhatsApp's side, clears the stored
 * login after the window is gone, and leaves nothing that reads as a lost link.
 * Any other way off keeps the login.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const login = vi.hoisted(() => ({
  calls: [] as string[],
  partitions: [] as string[],
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: {
      getPath: () => "/user-data",
      getPreferredSystemLanguages: () => [],
      getLocale: () => "en-US",
    },
    BrowserWindow: class {},
    session: {
      fromPartition: (partition: string) => {
        login.partitions.push(partition);
        return {
          clearStorageData: async () => {
            login.calls.push("clearStorageData");
          },
          clearCache: async () => {
            login.calls.push("clearCache");
          },
        };
      },
    },
    shell: { openExternal: async () => undefined },
    powerMonitor: new EventEmitter(),
    net: { isOnline: () => true },
  };
});

const { MessagingGatewayService } = await import("./messaging-gateway-service");
const { WhatsAppWebConnector, forgetWhatsAppLogin } =
  await import("./whatsapp-web-connector");
const {
  readPlatformLinkLost,
  readPlatformSignedIn,
  savePlatformLinkLost,
  savePlatformSignedIn,
  setPlatformEnabled,
} = await import("./messaging-config-service");

type Internals = {
  bridge: { logOut: () => Promise<void> } | null;
  bridgeReady: boolean;
  loginPoll: { stop: () => void };
  inboundPoll: { stop: () => void };
};

const connector = (): {
  subject: InstanceType<typeof WhatsAppWebConnector>;
  internals: Internals;
  logs: string[];
} => {
  const logs: string[] = [];
  const subject = new WhatsAppWebConnector({
    onMessage: () => {},
    onState: () => {},
    onLog: (line: string) => logs.push(line),
  } as never);
  return { subject, internals: subject as unknown as Internals, logs };
};

/** A gateway holding one live WhatsApp connector, with its steps recorded. */
const gatewayOnWhatsApp = (): {
  gateway: InstanceType<typeof MessagingGatewayService>;
  subject: InstanceType<typeof WhatsAppWebConnector>;
} => {
  const { subject, internals } = connector();
  internals.bridge = {
    logOut: async () => {
      login.calls.push("logOut");
    },
  };
  internals.bridgeReady = true;
  subject.stop = async () => {
    login.calls.push("stop");
  };
  const gateway = new MessagingGatewayService({
    emitChanged: () => {},
  } as never);
  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    "whatsapp",
    subject
  );
  return { gateway, subject };
};

describe("unlinking WhatsApp", () => {
  beforeEach(() => {
    vi.stubEnv(
      "ABACUSAI_BOT_HOME",
      fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-unlink-"))
    );
    login.calls.length = 0;
    login.partitions.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("logs out, closes the window, then clears the stored login", async () => {
    savePlatformSignedIn("whatsapp", true);
    setPlatformEnabled("whatsapp", true);
    const { gateway } = gatewayOnWhatsApp();

    await gateway.unlinkPlatform("whatsapp");

    expect(login.calls).toEqual([
      "logOut",
      "stop",
      "clearStorageData",
      "clearCache",
    ]);
    expect(login.partitions).toEqual(["persist:whatsapp-web"]);
    expect(readPlatformSignedIn("whatsapp")).toBe(false);
  });

  it("clears the login with no connector running", async () => {
    savePlatformSignedIn("whatsapp", true);
    const gateway = new MessagingGatewayService({
      emitChanged: () => {},
    } as never);

    await gateway.unlinkPlatform("whatsapp");

    expect(login.calls).toEqual(["clearStorageData", "clearCache"]);
  });

  it("keeps the login on every other way off", async () => {
    savePlatformSignedIn("whatsapp", true);
    setPlatformEnabled("whatsapp", true);
    const { gateway } = gatewayOnWhatsApp();

    await gateway.updatePlatform({ platformId: "whatsapp", enabled: false });

    expect(login.calls).toEqual(["stop"]);
    expect(readPlatformSignedIn("whatsapp")).toBe(true);
  });

  it("leaves other platforms' logins alone", async () => {
    const gateway = new MessagingGatewayService({
      emitChanged: () => {},
    } as never);

    await gateway.unlinkPlatform("discord");

    expect(login.calls).toEqual([]);
  });

  it("is not a lost link", async () => {
    savePlatformLinkLost("whatsapp");

    await forgetWhatsAppLogin();

    expect(readPlatformLinkLost("whatsapp")).toBe(false);
    expect(readPlatformSignedIn("whatsapp")).toBe(false);
  });

  it("stops the checks first, so the logout is not read as a lost link", async () => {
    const { subject, internals } = connector();
    const order: string[] = [];
    internals.loginPoll.stop = () => order.push("login poll");
    internals.inboundPoll.stop = () => order.push("inbound poll");
    internals.bridge = {
      logOut: async () => {
        order.push("logout");
      },
    };
    internals.bridgeReady = true;

    await subject.logOut();

    expect(order).toEqual(["login poll", "inbound poll", "logout"]);
  });

  it("goes on when the page never answers the logout", async () => {
    vi.useFakeTimers();
    const { subject, internals, logs } = connector();
    internals.bridge = { logOut: () => new Promise(() => {}) };
    internals.bridgeReady = true;

    const done = subject.logOut();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(logs.join("\n")).toContain("logout on unlink did not finish");
  });

  it("has nothing to log out of with no ready page", async () => {
    const { subject, internals } = connector();
    const logOut = vi.fn(async () => {});
    internals.bridge = { logOut };
    internals.bridgeReady = false;

    await subject.logOut();

    expect(logOut).not.toHaveBeenCalled();
  });
});
