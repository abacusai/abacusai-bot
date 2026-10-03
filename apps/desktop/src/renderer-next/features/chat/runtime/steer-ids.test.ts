import { expect, it, vi } from "vitest";

import { startRealHost, REAL_THREAD } from "#next/test-support/real-host";

import { ThreadSession } from "./session";

it("R2-T33 preserves distinct steer messages across agent respawn, recovery and hydrate", async () => {
  const host = await startRealHost({
    reply: (index, gates) =>
      index === 0
        ? gates.wait("first").then(() => ({ say: "First step." }))
        : { say: "Done." },
  });
  const sessions: ThreadSession[] = [];
  const open = async () => {
    const session = new ThreadSession({
      ai: await host.window(),
      threadId: REAL_THREAD,
    });
    sessions.push(session);
    await session.load();
    return session;
  };
  try {
    const view = await open();
    const steers: Array<{ id: string; text: string }> = [];
    for (const text of ["steer from process one", "steer from process two"]) {
      await view.submit("Start the next run.");
      await vi.waitFor(() => expect(host.agent().providerCalls()).toBe(1), {
        timeout: 20000,
      });
      await view.enqueue(text);
      host.agent().gates.open("first");
      await vi.waitFor(() => expect(view.store.state.runs.active).toBeNull(), {
        timeout: 20000,
      });
      const message = view.hostStore.state.messages.find(
        (m) =>
          m.role === "user" &&
          m.parts.some((p) => p.type === "text" && p.content === text)
      );
      expect(message).toBeDefined();
      steers.push({ id: message!.id, text });
      if (steers.length === 1) {
        await host.respawn();
        await view.reconnect();
      }
    }
    expect(new Set(steers.map((m) => m.id)).size).toBe(2);
    await view.reconnect();
    const later = await open();
    for (const session of [view, later])
      for (const { id, text } of steers) {
        const messages = session.hostStore.state.messages.filter(
          (m) => m.id === id
        );
        expect(messages).toHaveLength(1);
        expect(messages[0]!.parts).toContainEqual(
          expect.objectContaining({ type: "text", content: text })
        );
      }
  } finally {
    for (const session of sessions) session.retire();
    await host.close();
  }
}, 60000);
