import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ current: "" }));
const settings = vi.hoisted(() => ({
  current: {} as { serverDebugSync?: boolean },
}));

vi.mock("electron", () => ({
  app: { getVersion: () => "9.9.9", isPackaged: true },
}));
vi.mock("../../paths", () => ({ abacusBotHome: () => home.current }));
vi.mock("../../profile-home", () => ({ profileBaseDir: () => home.current }));
vi.mock("../config/settings", () => ({
  readSettings: () => settings.current,
}));
vi.mock("../providers/abacus-host", () => ({
  abacusAppHost: () => "https://apps.example.test",
  abacusUserAgent: () => "test-agent",
}));

import {
  reportFunnelStep,
  reportFunnelStepOnce,
  resetFunnelOnceForTests,
} from "./funnel-beacon";

const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));

beforeEach(() => {
  home.current = fs.mkdtempSync(path.join(os.tmpdir(), "funnel-"));
  settings.current = {};
  fetchMock.mockClear();
  resetFunnelOnceForTests();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(home.current, { recursive: true, force: true });
});

const requested = (): URL => {
  const [url] = fetchMock.mock.calls[0] as unknown as [URL];
  return url;
};

describe("reportFunnelStep", () => {
  it("sends the step, a code, the install id and the build facts, nothing else", () => {
    reportFunnelStep("signin_result", "http_403");

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = requested();
    expect(url.origin + url.pathname).toBe(
      "https://apps.example.test/api/v1/_abacusaibotFunnelStep"
    );
    expect(url.searchParams.get("step")).toBe("signin_result");
    expect(url.searchParams.get("detail")).toBe("http_403");
    expect(url.searchParams.get("install")).toBe(
      fs.readFileSync(path.join(home.current, "device-id"), "utf-8")
    );
    expect(url.searchParams.get("v")).toBe("9.9.9");
    expect(url.searchParams.get("build")).toBe("packaged");
    expect([...url.searchParams.keys()].sort()).toEqual([
      "arch",
      "build",
      "detail",
      "install",
      "os",
      "step",
      "v",
    ]);
  });

  it("reduces a detail to a short code", () => {
    reportFunnelStep("app_opened", "signed in: bob@example.com <script>");

    expect(requested().searchParams.get("detail")).toBe(
      "signedinbobexamplecomscript"
    );
  });

  it("stays home when diagnostics are off", () => {
    settings.current = { serverDebugSync: false };

    reportFunnelStep("app_opened");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("survives a failed request", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    expect(() => reportFunnelStep("app_opened")).not.toThrow();
    await Promise.resolve();
  });
});

describe("reportFunnelStepOnce", () => {
  it("reports a milestone once per install", () => {
    reportFunnelStepOnce("first_message");
    reportFunnelStepOnce("first_message");
    reportFunnelStepOnce("tour_done");

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A new run reads the file back rather than reporting again.
    resetFunnelOnceForTests();
    reportFunnelStepOnce("first_message");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(home.current, "funnel-once.json"), "utf-8")
      )
    ).toEqual({ first_message: true, tour_done: true });
  });
});
