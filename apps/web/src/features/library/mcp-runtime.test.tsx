import { implement } from "@orpc/server";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";
import { contract } from "#shared/contract";
import type { AgentMcpServer } from "#shared/contracts";
const notices = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));
vi.mock("#renderer/lib/toast", () => ({
  showError: notices.error,
  showInfo: notices.info,
}));
const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
  notices.error.mockClear();
  notices.info.mockClear();
});
const server = {
  id: "example",
  name: "example",
  isBuiltin: false,
  config: { command: "example" },
};
const live = (status: "connected" | "error") =>
  [{ id: "example", status }] as AgentMcpServer[];
it("retired MCP scope clears logs/status and ignores an outstanding server response", async () => {
  const seed = defaultSeed();
  const [first, second] = seed.sessions!;
  first!.status = second!.status = "running";
  let release!: (rows: AgentMcpServer[]) => void;
  app = await renderApp("/library/mcp?logs=example", {
    seed,
    procedures: {
      mcp: {
        list: os.mcp.list.handler(() => [server]),
        runtime: {
          servers: os.mcp.runtime.servers.handler(({ input }) =>
            input.sessionId === first!.id
              ? new Promise<AgentMcpServer[]>((resolve) => {
                  release = resolve;
                })
              : live("error")
          ),
          logs: os.mcp.runtime.logs.handler(
            ({ input }) => [{ line: `log:${input.sessionId}` }] as never
          ),
        },
      },
    },
  });
  await screen.findByText(`log:${first!.id}`);
  fireEvent.change(screen.getByRole("combobox", { name: "Running session" }), {
    target: { value: second!.id },
  });
  await screen.findByText(`log:${second!.id}`);
  await act(async () => release(live("connected")));
  expect(screen.queryByText("Connected")).toBeNull();
  await act(async () => {
    for (const row of seed.sessions!)
      app!.db.sessions.upsert({ ...row, status: "stopped" });
  });
  await screen.findByText("Start a session to manage live server connections.");
  expect(screen.queryByText(`log:${second!.id}`)).toBeNull();
});
it.each(["refresh", "restart", "oauth", "cancel"])(
  "MCP %s inspects its result",
  async (operation) => {
    const seed = defaultSeed();
    seed.sessions![0]!.status = "running";
    const refresh = vi.fn(async () => ({
      success: false,
      error: "refresh rejected",
    }));
    app = await renderApp("/library/mcp", {
      seed,
      procedures: {
        mcp: {
          list: os.mcp.list.handler(() => [server]),
          runtime: { servers: os.mcp.runtime.servers.handler(() => []) },
          refresh: os.mcp.refresh.handler(refresh),
          restart: os.mcp.restart.handler(() => ({
            success: false,
            error: "restart rejected",
          })),
          oauthSignIn: os.mcp.oauthSignIn.handler(() => ({
            success: false,
            cancelled: operation === "cancel",
            error: "oauth rejected",
          })),
        },
      },
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name:
          operation === "refresh"
            ? "Refresh"
            : operation === "restart"
              ? "Restart"
              : "Sign in",
      })
    );
    if (operation === "cancel") {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(notices.error).not.toHaveBeenCalled();
    } else
      await waitFor(() =>
        expect(notices.error).toHaveBeenCalledWith(`${operation} rejected`)
      );
    expect(notices.info).not.toHaveBeenCalled();
    if (operation === "oauth" || operation === "cancel")
      expect(refresh).not.toHaveBeenCalled();
  }
);
