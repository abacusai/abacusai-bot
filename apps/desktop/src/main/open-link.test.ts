import { describe, expect, it, vi } from "vitest";

import { launchLink, OpenLinkInbox, registerOpenLinkScheme } from "./open-link";

const inbox = () => {
  const deps = { reveal: vi.fn(), announce: vi.fn(), funnel: vi.fn() };
  return { deps, links: new OpenLinkInbox(deps) };
};

describe("OpenLinkInbox", () => {
  it("holds a link until it is taken, once", () => {
    const { deps, links } = inbox();
    expect(
      links.receive("abacusaibot://open?session=s1&draft=Hi&src=Email_D1")
    ).toBe(true);
    expect(deps.funnel).toHaveBeenCalledWith("email_d1");
    expect(deps.reveal).toHaveBeenCalledTimes(1);
    expect(deps.announce).toHaveBeenCalledTimes(1);
    expect(links.take()).toEqual({
      sessionId: "s1",
      draft: "Hi",
      src: "email_d1",
    });
    expect(links.take()).toBeNull();
  });

  it("keeps the newest of two links", () => {
    const { links } = inbox();
    links.receive("abacusaibot://open?session=old");
    links.receive("abacusaibot://open?session=new");
    expect(links.take()?.sessionId).toBe("new");
  });

  it("does nothing for a link that is not ours", () => {
    const { deps, links } = inbox();
    expect(links.receive("abacusaibot://approve?session=s")).toBe(false);
    expect(deps.reveal).not.toHaveBeenCalled();
    expect(deps.funnel).not.toHaveBeenCalled();
    expect(links.take()).toBeNull();
  });
});

describe("launchLink", () => {
  it("opens a launch's link once across relaunches", () => {
    const env: NodeJS.ProcessEnv = {};
    const argv = ["app", "abacusaibot://open?session=s"];
    expect(launchLink(argv, env)).toBe("abacusaibot://open?session=s");
    // app.relaunch() repeats argv and keeps the environment.
    expect(launchLink(argv, env)).toBeNull();
    expect(launchLink(["app"], {})).toBeNull();
  });
});

describe("registerOpenLinkScheme", () => {
  const platform = process.platform;
  const app = (isPackaged: boolean) => ({
    isPackaged,
    setAsDefaultProtocolClient: vi.fn(() => true),
  });

  it.each<[NodeJS.Platform, boolean, boolean]>([
    ["win32", true, true],
    ["linux", true, true],
    // The bundle declares it on macOS.
    ["darwin", true, false],
    // A dev run never takes the scheme from an installed app.
    ["win32", false, false],
    ["linux", false, false],
  ])("on %s, packaged %s: registers %s", (os, packaged, registers) => {
    Object.defineProperty(process, "platform", { value: os });
    try {
      const target = app(packaged);
      registerOpenLinkScheme(target);
      expect(target.setAsDefaultProtocolClient.mock.calls).toEqual(
        registers ? [["abacusaibot"]] : []
      );
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
  });
});
