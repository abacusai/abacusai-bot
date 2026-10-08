import { contract } from "@abacus-ai/contract/contract";
import type {
  MessagingPlatformId,
  MessagingSnapshot,
} from "@abacus-ai/contract/messaging";
import { implement, ORPCError } from "@orpc/server";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { renderApp } from "#renderer/test-support/app-harness";
const os = implement(contract);
const setup = (
  platform: MessagingPlatformId = "whatsapp",
  unlinkFails = false
) => {
  const calls: string[] = [];
  let snapshot = {
    gatewayEnabled: true,
    autoApproveTools: false,
    respondToInbound: false,
    workspaceId: null,
    botId: null,
    approved: [],
    pending: [],
    autoReplies: [],
    platforms: [
      platform,
      ...(platform === "discord" ? ["abacus_discord" as const] : []),
    ].map((id) => ({
      id,
      nameKey: id,
      enabled: false,
      configured: true,
      state: "needs_login",
      fields: [],
      docsUrl: "",
      errorMessage: null,
      pendingCount: 0,
      sharedLink: { status: "pending" },
    })),
  } as MessagingSnapshot;
  return {
    calls,
    snapshot: () => snapshot,
    procedures: {
      messaging: {
        snapshot: os.messaging.snapshot.handler(() => snapshot),
        updatePlatform: os.messaging.updatePlatform.handler(({ input }) => {
          calls.push(`${input.platformId}:${input.enabled}`);
          snapshot = {
            ...snapshot,
            platforms: snapshot.platforms.map((p) =>
              p.id === input.platformId
                ? { ...p, enabled: input.enabled ?? p.enabled }
                : p
            ),
          };
          return snapshot;
        }),
        showLogin: os.messaging.showLogin.handler(() => {}),
        pairShared: os.messaging.pairShared.handler(() => snapshot),
        unlinkShared: os.messaging.unlinkShared.handler(({ input }) => {
          calls.push(`unlink:${input.platformId}`);
          if (unlinkFails)
            throw new ORPCError("BAD_REQUEST", {
              message: "remote unlink failed",
              data: {},
            });
          return snapshot;
        }),
      },
    },
  };
};
it.each(["Escape", "Done", "navigation"])(
  "direct Messaging Connect settles unfinished setup on %s",
  async (close) => {
    const d = setup();
    const app = await renderApp("/library/messaging", {
      procedures: d.procedures,
    });
    try {
      fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
      await screen.findByRole("dialog");
      await waitFor(() => expect(d.calls).toContain("whatsapp:true"));
      if (close === "Done")
        fireEvent.click(screen.getByRole("button", { name: "Done" }));
      else if (close === "Escape")
        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      else
        await act(async () => {
          await app.router.navigate({ to: "/settings/general" });
        });
      await waitFor(() =>
        expect(
          d.calls.filter((call) => call === "whatsapp:false")
        ).toHaveLength(1)
      );
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  }
);
it.each([false, true])(
  "Unlink awaits remote unlink and preserves activation on failure=%s",
  async (fail) => {
    const d = setup("discord", fail);
    const app = await renderApp("/library/messaging?platform=discord", {
      procedures: d.procedures,
    });
    try {
      await waitFor(() => expect(d.calls).toContain("abacus_discord:true"));
      fireEvent.click(
        await screen.findByRole("button", { name: enUS.phase5.unlink })
      );
      fireEvent.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", {
          name: enUS.phase5.unlink,
        })
      );
      await waitFor(() => expect(d.calls).toContain("unlink:abacus_discord"));
      if (fail) {
        expect(await screen.findByText("remote unlink failed")).not.toBeNull();
        expect(d.calls).not.toContain("discord:false");
      } else
        await waitFor(() =>
          expect(d.calls.slice(-3)).toEqual([
            "unlink:abacus_discord",
            "abacus_discord:false",
            "discord:false",
          ])
        );
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  }
);

it("changing the Messaging route settles delayed WhatsApp setup and preserves the new watchdog", async () => {
  const d = setup();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let setupStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    setupStarted = resolve;
  });
  const snapshot = {
    gatewayEnabled: true,
    autoApproveTools: false,
    respondToInbound: false,
    workspaceId: null,
    botId: null,
    platforms: [],
    autoReplies: [],
    pending: [],
    approved: [],
  } as unknown as MessagingSnapshot;
  d.procedures.messaging.updatePlatform = os.messaging.updatePlatform.handler(
    async (context) => {
      if (context.input.platformId === "whatsapp" && context.input.enabled) {
        setupStarted();
        await ready;
      }
      d.calls.push(`${context.input.platformId}:${context.input.enabled}`);
      return snapshot;
    }
  );
  const app = await renderApp("/library/messaging?platform=whatsapp", {
    procedures: d.procedures,
  });
  try {
    await screen.findByRole("dialog");
    await started;
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(179000);
    });
    await act(async () => {
      await app.router.navigate({
        to: "/library/messaging",
        search: { platform: "telegram" },
      });
    });
    // The router promise settles before the new panel's passive effects.
    // Arm its watchdog before advancing the virtual clock.
    await vi.waitFor(async () => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(d.calls).toContain("telegram:true");
    });
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(1000);
    });
    await vi.waitFor(async () => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(
        d.calls.filter((call) => call === "whatsapp:false"),
        JSON.stringify(d.calls)
      ).toHaveLength(1);
    });
    expect(d.calls).toContain("telegram:true");
    expect(d.calls).not.toContain("telegram:false");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(179000);
    });
    await vi.waitFor(async () => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(
        d.calls.filter((call) => call === "telegram:false"),
        JSON.stringify(d.calls)
      ).toHaveLength(1);
    });
  } finally {
    release();
    vi.useRealTimers();
    app.view.unmount();
    await app.cleanup();
  }
});

it("Messaging dialog pushes a shareable URL, closes to its origin and restores focus", async () => {
  const d = setup();
  const app = await renderApp("/library/messaging", {
    procedures: d.procedures,
  });
  try {
    const connect = await screen.findByRole("button", { name: "Connect" });
    connect.focus();
    const index = app.router.history.location.state.__TSR_index;
    fireEvent.click(connect);
    await screen.findByRole("dialog", { name: "WhatsApp" });
    expect(app.router.state.location.href).toBe(
      "/library/messaging?platform=whatsapp"
    );
    expect(app.router.state.location.maskedLocation).toBeUndefined();
    expect(app.router.history.location.state.__TSR_index).toBe(index + 1);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(app.router.history.location.state.__TSR_index).toBe(index);
    await waitFor(() => expect(document.activeElement).toBe(connect));
    await act(() => {
      app.router.history.forward();
    });
    await screen.findByRole("dialog", { name: "WhatsApp" });
    await act(() => {
      app.router.history.back();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("a cold Messaging dialog link closes by replacement without reopening on Back", async () => {
  const d = setup();
  const app = await renderApp("/library/messaging?platform=whatsapp", {
    procedures: d.procedures,
  });
  try {
    await screen.findByRole("dialog", { name: "WhatsApp" });
    const length = app.router.history.length;
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(app.router.state.location.href).toBe("/library/messaging");
    expect(app.router.history.length).toBe(length);
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("channel details retain pairing decisions and independent bot auto-reply controls", async () => {
  const d = setup();
  const sender = (
    userId: string,
    status: "pending" | "approved" | "paused",
    botId?: string
  ) => ({
    platform: "whatsapp" as const,
    userId,
    userName: userId,
    chatId: userId,
    status,
    botId,
    managedBy: botId ? ("bot" as const) : undefined,
    firstSeenAt: "2026-10-01T00:00:00Z",
    firstMessage: "Hello",
  });
  let snapshot: MessagingSnapshot = {
    ...d.snapshot(),
    pending: [sender("Pending sender", "pending")],
    autoReplies: [
      sender("First bot sender", "approved", "chief-of-staff"),
      sender("Second bot sender", "paused", "research"),
    ],
  };
  const decisions = vi.fn();
  const app = await renderApp("/library/messaging?platform=whatsapp", {
    procedures: {
      messaging: {
        ...d.procedures.messaging,
        snapshot: os.messaging.snapshot.handler(() => snapshot),
        updatePlatform: os.messaging.updatePlatform.handler(() => snapshot),
        decidePairing: os.messaging.decidePairing.handler(({ input }) => {
          decisions(input);
          snapshot = {
            ...snapshot,
            pending: snapshot.pending.filter(
              (user) => user.userId !== input.userId
            ),
            autoReplies: snapshot.autoReplies.map((user) =>
              user.userId === input.userId
                ? {
                    ...user,
                    status: input.decision === "pause" ? "paused" : "approved",
                  }
                : user
            ),
          };
          return snapshot;
        }),
      },
    },
  });
  try {
    await screen.findByRole("dialog");
    const row = (name: string) =>
      screen.getByText(name).closest("[data-setting-id]") as HTMLElement;
    fireEvent.click(
      within(row("First bot sender")).getByRole("button", { name: "Pause" })
    );
    await waitFor(() =>
      expect(decisions).toHaveBeenCalledWith({
        platformId: "whatsapp",
        userId: "First bot sender",
        decision: "pause",
      })
    );
    expect(
      within(row("Second bot sender")).getByRole("button", { name: "Resume" })
    ).not.toBeNull();
    fireEvent.click(
      within(row("Pending sender")).getByRole("button", { name: "Approve" })
    );
    await waitFor(() =>
      expect(screen.queryByText("Pending sender")).toBeNull()
    );
    expect(decisions).toHaveBeenCalledWith({
      platformId: "whatsapp",
      userId: "Pending sender",
      decision: "approve",
    });
    expect(screen.getByText("Second bot sender")).not.toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
