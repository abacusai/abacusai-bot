/**
 * The provisional shell (spec 09 D12): while the browser's host is still
 * connecting, a route renders when the user's last-known flags agree with it,
 * every other case waits for the host, the one redirect comes from fresh
 * state, and writes are released only by a gate that kept its route.
 */
import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { TransportState } from "#renderer/data/transport/lifecycle";
import type { MemoryTransport } from "#renderer/data/transport/memory";
import type { Transport } from "#renderer/data/transport/types";
import { signedInQuery } from "#renderer/features/onboarding/actions";
import { followWriteAuthorization } from "#renderer/features/onboarding/gate";
import { identifyHost } from "#renderer/features/shell/connect/services";
import { createHarness } from "#renderer/test-support/app-harness";

const GATE_KEY = "abacusai-bot:last-known:gate:conversation";

beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        result: { deploymentConversationId: "conversation" },
      })
    )
  );
  await identifyHost();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

/** Rendered without awaiting the router: its gates may wait for the host. */
const renderApp = async (
  path: string,
  options: Parameters<typeof createHarness>[1]
) => {
  const harness = await createHarness(path, options);
  const queryClient = (harness.router as { __queryClient?: unknown })
    .__queryClient as import("@tanstack/react-query").QueryClient;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={harness.router} />
    </QueryClientProvider>
  );
  return { ...harness, view, queryClient };
};

let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});

/** The router's transport: still connecting, with the write gate observed. */
const connecting = () => {
  let state: TransportState = "connecting";
  let generation = 0;
  const listeners = new Set<() => void>();
  const order: string[] = [];
  const wrap = (memory: MemoryTransport): Transport => ({
    kind: memory.kind,
    client: memory.client,
    orpc: memory.orpc,
    host: memory.host,
    get state() {
      return state;
    },
    get generation() {
      return generation;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    writeTicket: () => 0,
    confirmWrites: () => order.push("confirm"),
    suspendWrites: () => order.push("suspend"),
    revokeWrites: () => order.push("drop"),
    onClose: memory.onClose,
    close: () => memory.close(),
  });
  return {
    wrap,
    order,
    open() {
      state = "open";
      generation += 1;
      for (const listener of Array.from(listeners)) listener();
    },
    drop() {
      state = "reconnecting";
      for (const listener of Array.from(listeners)) listener();
    },
  };
};

/** The host's gate answers, held until `answer()`. */
const host = (initial: { onboarded: boolean; signedIn: boolean }) => {
  const impl = implement(contract);
  let release!: () => void;
  const up = new Promise<void>((resolve) => {
    release = resolve;
  });
  const flags = { ...initial };
  const calls: string[] = [];
  return {
    flags,
    calls,
    answer: release,
    procedures: {
      account: {
        state: impl.account.state.handler(async () => {
          await up;
          return { account: null, apps: [], onboarded: flags.onboarded };
        }),
      },
      settings: {
        get: impl.settings.get.handler(async () => {
          calls.push("settings.get");
          await up;
          return {
            defaultModel: null,
            apiKeys: flags.signedIn ? { ABACUS_API_KEY: "credential" } : {},
          } as never;
        }),
      },
    },
  };
};

const shellVisible = () => document.querySelector('[data-slot="shell"]');
const remember = (flags: { onboarded: boolean; signedIn: boolean }) =>
  localStorage.setItem(GATE_KEY, JSON.stringify(flags));

it("renders the shell from last-known flags, then redirects once from fresh state, keeping the destination", async () => {
  remember({ onboarded: true, signedIn: true });
  const transport = connecting();
  const answers = host({ onboarded: true, signedIn: false });
  app = await renderApp("/settings/keyboard", {
    procedures: answers.procedures,
    wrapTransport: transport.wrap,
  });
  await waitFor(() => expect(shellVisible()).not.toBeNull());
  expect(transport.order).toEqual([]);

  await act(async () => {
    transport.open();
    answers.answer();
  });
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toMatch(/^\/onboarding\//)
  );
  // Writes made in the provisional shell were never sent; onboarding's own
  // gate then keeps its route.
  expect(transport.order[0]).toBe("drop");
  expect(transport.order.slice(1).every((step) => step === "confirm")).toBe(
    true
  );
  expect(
    localStorage.getItem("abacusai-bot:last-known:destination:conversation")
  ).toContain("/settings/keyboard");
  expect(JSON.parse(localStorage.getItem(GATE_KEY)!)).toEqual({
    onboarded: true,
    signedIn: false,
  });
});

it("releases held writes only once the host confirms the shell", async () => {
  remember({ onboarded: true, signedIn: true });
  const transport = connecting();
  const answers = host({ onboarded: true, signedIn: true });
  app = await renderApp("/settings/keyboard", {
    procedures: answers.procedures,
    wrapTransport: transport.wrap,
  });
  await waitFor(() => expect(shellVisible()).not.toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(transport.order).toEqual([]);
  await act(async () => {
    transport.open();
    answers.answer();
  });
  await waitFor(() => expect(transport.order).toEqual(["confirm"]));
  expect(app.router.state.location.pathname).toBe("/settings/keyboard");
});

it("waits for the host when the last-known flags disagree with the route", async () => {
  remember({ onboarded: false, signedIn: false });
  const transport = connecting();
  const answers = host({ onboarded: true, signedIn: true });
  app = await renderApp("/settings/keyboard", {
    procedures: answers.procedures,
    wrapTransport: transport.wrap,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  // No redirect from stale flags, and no provisional shell either.
  expect(shellVisible()).toBeNull();
  expect(app.router.state.location.pathname).toBe("/settings/keyboard");
  await act(async () => {
    transport.open();
    answers.answer();
  });
  await waitFor(() => expect(shellVisible()).not.toBeNull());
  expect(app.router.state.location.pathname).toBe("/settings/keyboard");
  expect(transport.order).toEqual(["confirm"]);
});

it("waits for the host on a first visit (nothing remembered)", async () => {
  const transport = connecting();
  const answers = host({ onboarded: true, signedIn: true });
  app = await renderApp("/settings/keyboard", {
    procedures: answers.procedures,
    wrapTransport: transport.wrap,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(shellVisible()).toBeNull();
  await act(async () => {
    transport.open();
    answers.answer();
  });
  await waitFor(() => expect(shellVisible()).not.toBeNull());
});

it("keeps a direct onboarding URL until the host answers, then leaves it for a signed-in user", async () => {
  remember({ onboarded: true, signedIn: true });
  const transport = connecting();
  const answers = host({ onboarded: true, signedIn: true });
  app = await renderApp("/onboarding/welcome", {
    procedures: answers.procedures,
    wrapTransport: transport.wrap,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(app.router.state.location.pathname).toBe("/onboarding/welcome");
  await act(async () => {
    transport.open();
    answers.answer();
  });
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toBe("/bots/new")
  );
  // Dropped by onboarding's gate, then released by the shell's.
  expect(transport.order).toEqual(["drop", "confirm"]);
});

it("sends a signed-out user to onboarding once the shell is confirmed", async () => {
  remember({ onboarded: true, signedIn: true });
  const transport = connecting();
  const answers = host({ onboarded: true, signedIn: true });
  app = await renderApp("/settings/keyboard", {
    procedures: answers.procedures,
    wrapTransport: transport.wrap,
  });
  await act(async () => {
    transport.open();
    answers.answer();
  });
  await waitFor(() => expect(transport.order).toEqual(["confirm"]));
  // Signed out elsewhere: the credentials notice invalidates the check.
  answers.flags.signedIn = false;
  await act(async () => {
    await app!.queryClient.invalidateQueries();
    await app!.router.invalidate();
  });
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toMatch(/^\/onboarding\//)
  );
});

const stepVisible = () => document.querySelector("[data-onboarding-step]");

it("renders onboarding provisionally from last-known flags, then leaves for the remembered destination once the host says onboarded", async () => {
  remember({ onboarded: false, signedIn: false });
  localStorage.setItem(
    "abacusai-bot:last-known:destination:conversation",
    JSON.stringify("/settings/keyboard")
  );
  const transport = connecting();
  const answers = host({ onboarded: true, signedIn: true });
  app = await renderApp("/onboarding/welcome", {
    procedures: answers.procedures,
    wrapTransport: transport.wrap,
  });
  // The step renders while nothing is known, and redirects nowhere.
  await waitFor(() => expect(stepVisible()).not.toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(app.router.state.location.pathname).toBe("/onboarding/welcome");
  expect(transport.order).toEqual([]);
  await act(async () => {
    transport.open();
    answers.answer();
  });
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toBe("/settings/keyboard")
  );
  // One redirect: onboarding's gate left (writes revoked), the shell's kept.
  expect(transport.order).toEqual(["drop", "confirm"]);
  // Taken once, then cleared by the kept shell.
  expect(
    JSON.parse(
      localStorage.getItem("abacusai-bot:last-known:destination:conversation")!
    )
  ).toBeNull();
});

it("runs the step's own guard from fresh facts once the host confirms onboarding", async () => {
  remember({ onboarded: false, signedIn: false });
  const transport = connecting();
  const answers = host({ onboarded: false, signedIn: false });
  app = await renderApp("/onboarding/connectors", {
    procedures: answers.procedures,
    wrapTransport: transport.wrap,
  });
  // Provisional: no guard yet, the asked-for step renders.
  await waitFor(() =>
    expect(stepVisible()?.getAttribute("data-onboarding-step")).toBe(
      "connectors"
    )
  );
  await act(async () => {
    transport.open();
    answers.answer();
  });
  // Fresh facts: a signed-out user starts at welcome (whose sign-in may
  // already have moved on to connect).
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toMatch(
      /^\/onboarding\/(welcome|connect)$/
    )
  );
  expect(transport.order.every((step) => step === "confirm")).toBe(true);
});

it("suspends writes when the signed-in answer is invalidated, and revokes them when the shell then leaves", async () => {
  remember({ onboarded: true, signedIn: true });
  const transport = connecting();
  const answers = host({ onboarded: true, signedIn: true });
  app = await renderApp("/settings/keyboard", {
    procedures: answers.procedures,
    wrapTransport: transport.wrap,
  });
  await act(async () => {
    transport.open();
    answers.answer();
  });
  await waitFor(() => expect(transport.order).toEqual(["confirm"]));
  const routed = app.router.options.context as {
    transport: Transport;
    queryClient: import("@tanstack/react-query").QueryClient;
  };
  const stop = followWriteAuthorization(routed, app.router);
  try {
    // Signed out elsewhere: only the credentials notice arrives.
    answers.flags.signedIn = false;
    await act(async () => {
      await app!.queryClient.invalidateQueries({
        queryKey: signedInQuery(routed.transport).queryKey,
      });
    });
    await waitFor(() =>
      expect(app!.router.state.location.pathname).toMatch(/^\/onboarding\//)
    );
    expect(transport.order.slice(0, 3)).toEqual(["confirm", "suspend", "drop"]);
  } finally {
    stop();
  }
});

it("re-confirms writes after the signed-in answer is refreshed and still signed in", async () => {
  remember({ onboarded: true, signedIn: true });
  const transport = connecting();
  const answers = host({ onboarded: true, signedIn: true });
  app = await renderApp("/settings/keyboard", {
    procedures: answers.procedures,
    wrapTransport: transport.wrap,
  });
  await act(async () => {
    transport.open();
    answers.answer();
  });
  await waitFor(() => expect(transport.order).toEqual(["confirm"]));
  const routed = app.router.options.context as {
    transport: Transport;
    queryClient: import("@tanstack/react-query").QueryClient;
  };
  const stop = followWriteAuthorization(routed, app.router);
  try {
    await act(async () => {
      await app!.queryClient.invalidateQueries({
        queryKey: signedInQuery(routed.transport).queryKey,
      });
    });
    await waitFor(() =>
      expect(transport.order).toEqual(["confirm", "suspend", "confirm"])
    );
    expect(app.router.state.location.pathname).toBe("/settings/keyboard");
  } finally {
    stop();
  }
});

it("re-runs the gate on a replacement socket, also with nothing cached, before writes go out again", async () => {
  remember({ onboarded: true, signedIn: true });
  const transport = connecting();
  const answers = host({ onboarded: true, signedIn: true });
  app = await renderApp("/settings/keyboard", {
    procedures: answers.procedures,
    wrapTransport: transport.wrap,
  });
  const routed = app.router.options.context as {
    transport: Transport;
    queryClient: import("@tanstack/react-query").QueryClient;
  };
  const stop = followWriteAuthorization(routed, app.router);
  try {
    await act(async () => {
      transport.open();
      answers.answer();
    });
    await waitFor(() => expect(transport.order).toEqual(["confirm"]));
    // The cached answer is gone (garbage-collected) when the socket drops.
    app.queryClient.removeQueries({
      queryKey: signedInQuery(routed.transport).queryKey,
    });
    const asked = answers.calls.length;
    await act(async () => {
      transport.drop();
      transport.open();
    });
    await waitFor(() =>
      expect(transport.order.slice(1)).toEqual(["suspend", "confirm"])
    );
    expect(answers.calls.slice(asked)).toContain("settings.get");
  } finally {
    stop();
  }
});
