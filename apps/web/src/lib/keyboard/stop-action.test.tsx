import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";

import { ChatView, createChatRuntime } from "#renderer/features/chat";
import * as b from "#renderer/features/chat/fixtures/builders";
import { FakeRelay } from "#renderer/features/chat/fixtures/relay";
import { renderWithDb } from "#renderer/features/chat/testing";

import { ActionBindingsContext } from "./action-bindings";
import { resolveKeymap } from "./actions";

it.each([true, false])(
  "mounted chat Stop honors rebinding and unbinding with focused=%s",
  async (focused) => {
    const relay = new FakeRelay();
    relay.emitAll([...b.sessionReady(), b.runStarted("r"), b.textStart("a")]);
    const runtime = createChatRuntime(relay.ai);
    await runtime.session(relay.threadId).load();
    const View = () => {
      const [keymap, setKeymap] = useState<Record<string, string | null>>({
        "stop-run": null,
      });
      return (
        <ActionBindingsContext value={resolveKeymap(keymap, "mac").window}>
          <button onClick={() => setKeymap({ "stop-run": "Mod+Shift+L" })}>
            Rebind
          </button>
          <ChatView
            threadId={relay.threadId}
            runtime={runtime}
            workspaceRoot={null}
            skin="session"
            focused={focused}
            composer={{
              mode: "full",
              placeholder: "Message",
              attachmentsBase: null,
              showModeChip: false,
              model: null,
            }}
          />
        </ActionBindingsContext>
      );
    };
    const app = await renderWithDb(<View />);
    try {
      await screen.findByRole("button", { name: "Stop" });
      const press = (key: string, shiftKey = false) =>
        fireEvent.keyDown(document.body, {
          key,
          code: key === "." ? "Period" : "KeyL",
          metaKey: true,
          shiftKey,
        });
      press(".");
      await act(async () => {});
      expect(relay.stats.cancel).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "Rebind" }));
      press(".");
      await act(async () => {});
      expect(relay.stats.cancel).toHaveLength(0);
      press("l", true);
      await waitFor(() =>
        expect(relay.stats.cancel).toHaveLength(focused ? 1 : 0)
      );
    } finally {
      await app.cleanup();
      runtime.forget(relay.threadId);
    }
  }
);
