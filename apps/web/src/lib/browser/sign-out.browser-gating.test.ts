import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";

import type { RouterContext } from "#renderer/router";

import {
  clearBotStorage,
  installSignOutUnmount,
  signOutWithoutApp,
  webSignOut,
} from "./sign-out";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  installSignOutUnmount(() => {});
});

it("invalidates the website session before stopping the app and removing user state", async () => {
  const events: string[] = [];
  const queryClient = new QueryClient();
  queryClient.setQueryData(["account"], { name: "Ada Example" });
  localStorage.setItem("abacusai-bot:last-known:gate:dummy", "signed in");
  sessionStorage.setItem("abacusai-bot:abacus.chat.drafts", "private draft");
  localStorage.setItem("website-preference", "keep");
  sessionStorage.setItem("tsr-scroll-restoration-v1_3", "old session URLs");
  const fetch = vi.fn(async () => {
    events.push("logout");
    expect(queryClient.getQueryData(["account"])).toBeDefined();
    return new Response(JSON.stringify({ success: true, result: null }));
  });
  vi.stubGlobal("fetch", fetch);
  installSignOutUnmount(() => events.push("unmount"));
  const context = {
    queryClient,
    transport: { close: () => events.push("disconnect") },
    db: {
      stop: () => events.push("stop"),
      collections: { prefs: { cleanup: async () => events.push("cleanup") } },
    },
  } as unknown as RouterContext;
  await webSignOut(context, () => {
    events.push("leave");
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(
      localStorage.getItem("abacusai-bot:last-known:gate:dummy")
    ).toBeNull();
    expect(
      sessionStorage.getItem("abacusai-bot:abacus.chat.drafts")
    ).toBeNull();
  });
  expect(fetch).toHaveBeenCalledWith(
    "/api/_signOut",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: "{}",
    })
  );
  expect(events).toEqual([
    "logout",
    "unmount",
    "stop",
    "disconnect",
    "cleanup",
    "leave",
  ]);
  expect(localStorage.getItem("website-preference")).toBe("keep");
  // A persisted store's final pagehide flush must not restore the old account.
  sessionStorage.setItem("abacusai-bot:abacus.chat.drafts", "late flush");
  window.dispatchEvent(new Event("pagehide"));
  expect(sessionStorage.getItem("abacusai-bot:abacus.chat.drafts")).toBeNull();
});

it.each(["rejected", "network"])(
  "keeps the app usable and rejects visibly when logout is %s",
  async (kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (kind === "network") throw new TypeError("offline");
        return new Response(
          JSON.stringify({ success: false, error: "Logout failed" }),
          { status: 500 }
        );
      })
    );
    const stop = vi.fn();
    const leave = vi.fn();
    installSignOutUnmount(stop);
    localStorage.setItem("abacusai-bot:test", "keep");
    await expect(webSignOut({} as RouterContext, leave)).rejects.toThrow();
    expect(stop).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
    expect(localStorage.getItem("abacusai-bot:test")).toBe("keep");
  }
);

it("clears only bot namespaces in both storage areas", () => {
  for (const storage of [localStorage, sessionStorage]) {
    storage.setItem("abacusai-bot:dummy", "remove");
    storage.setItem("website", "keep");
  }
  clearBotStorage();
  for (const storage of [localStorage, sessionStorage]) {
    expect(storage.getItem("abacusai-bot:dummy")).toBeNull();
    expect(storage.getItem("website")).toBe("keep");
  }
});

it("signs out with no app mounted: the website session, other tabs, then bot data", async () => {
  const events: string[] = [];
  const peer = new BroadcastChannel("abacusai-bot:sign-out");
  const told = new Promise<unknown>((resolve) => {
    peer.onmessage = ({ data }) => resolve(data);
  });
  localStorage.setItem("abacusai-bot:dummy", "remove");
  localStorage.setItem("website-preference", "keep");
  const fetch = vi.fn(async () => {
    events.push("logout");
    return Response.json({ success: true, result: null });
  });
  vi.stubGlobal("fetch", fetch);
  try {
    await signOutWithoutApp(() => events.push("leave"));
    expect(fetch).toHaveBeenCalledWith(
      "/api/_signOut",
      expect.objectContaining({ method: "POST" })
    );
    expect(events).toEqual(["logout", "leave"]);
    expect(await told).toBe("signed-out");
    expect(localStorage.getItem("abacusai-bot:dummy")).toBeNull();
    expect(localStorage.getItem("website-preference")).toBe("keep");
  } finally {
    peer.close();
  }
});

it("keeps the page and its bot data when an app-less sign-out is rejected", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ success: false, error: "Logout failed" }, { status: 500 })
    )
  );
  const leave = vi.fn();
  localStorage.setItem("abacusai-bot:test", "keep");
  await expect(signOutWithoutApp(leave)).rejects.toThrow();
  expect(leave).not.toHaveBeenCalled();
  expect(localStorage.getItem("abacusai-bot:test")).toBe("keep");
});
