import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import { act, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  get: vi.fn(),
  peek: vi.fn(),
  hide: vi.fn(),
}));
vi.mock("../data/queries", () => {
  const transport = {
    client: { terminal: { start: mocks.start, hide: mocks.hide } },
  };
  return { useSessionsTransport: () => transport };
});
vi.mock("./terminal-registry", () => ({
  getTerminalView: mocks.get,
  // A view exists only once a tab was shown; these tests make one up front.
  peekTerminalView: (key: string) =>
    mocks.peek.getMockImplementation() ? mocks.peek(key) : mocks.get(key),
}));
import { TerminalTab } from "./terminal-tab";
const props = {
  row: { workspaceId: "w", id: "s" } as SessionRow,
  id: "t",
  visible: true,
  onClose: vi.fn(),
  dispatch: vi.fn(),
  onUrl: vi.fn(),
};
const makeView = () => ({
  element: document.createElement("div"),
  fit: { proposeDimensions: () => null },
  term: {
    cols: 80,
    rows: 24,
    resize: vi.fn(),
    focus: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    attachCustomKeyEventHandler: vi.fn(),
  },
  generation: null,
});
it("unmount during terminal.start installs no listeners and cannot detach the remounted owner", async () => {
  const view = makeView();
  mocks.get.mockResolvedValue(view);
  let resolve!: (value: unknown) => void;
  mocks.start.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const mounted = render(<TerminalTab {...props} />);
  await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
  mounted.unmount();
  const remountHost = document.createElement("div");
  remountHost.append(view.element);
  await act(async () => {
    resolve({ success: true, state: { generation: 1 } });
  });
  expect(view.term.onData).not.toHaveBeenCalled();
  expect(view.element.parentElement).toBe(remountHost);
});
it("partial initialization disposes input if installing the key handler throws", async () => {
  const view = makeView();
  const dispose = vi.fn();
  view.term.onData.mockReturnValue({ dispose });
  view.term.attachCustomKeyEventHandler.mockImplementation(() => {
    throw new Error("adapter failure");
  });
  mocks.get.mockResolvedValue(view);
  mocks.start.mockResolvedValue({ success: true, state: { generation: 1 } });
  const mounted = render(<TerminalTab {...props} />);
  await waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  mounted.unmount();
  expect(dispose).toHaveBeenCalledOnce();
});

it("refits a retained terminal when its pane is revealed without restarting it", async () => {
  const refit = vi.fn();
  const view = { ...makeView(), generation: 1, refit };
  mocks.get.mockResolvedValue(view);
  mocks.start.mockImplementation(() => new Promise(() => {}));
  mocks.hide.mockResolvedValue(undefined);
  const mounted = render(<TerminalTab {...props} />);
  await waitFor(() => expect(refit).toHaveBeenCalledOnce());
  const starts = mocks.start.mock.calls.length;
  mounted.rerender(<TerminalTab {...props} visible={false} />);
  await waitFor(() => expect(mocks.hide).toHaveBeenCalled());
  mounted.rerender(<TerminalTab {...props} visible />);
  await waitFor(() => expect(refit).toHaveBeenCalledTimes(2));
  expect(mocks.start.mock.calls).toHaveLength(starts);
  mounted.unmount();
});

it("starts no shell and makes no screen for a tab until it is first shown", async () => {
  mocks.get.mockReset();
  mocks.start.mockReset();
  const view = makeView();
  mocks.get.mockResolvedValue(view);
  mocks.peek.mockImplementation(() => null);
  mocks.start.mockResolvedValue({ success: true, state: { generation: 1 } });
  const mounted = render(<TerminalTab {...props} visible={false} />);
  await act(async () => {});
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
  mounted.rerender(<TerminalTab {...props} visible />);
  await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
  // Hidden again: the shell keeps running, nothing starts twice.
  mounted.rerender(<TerminalTab {...props} visible={false} />);
  await act(async () => {});
  expect(mocks.start).toHaveBeenCalledOnce();
  mounted.unmount();
});

it("a shell that ended while its screen was away starts again, with nothing reported", async () => {
  mocks.get.mockReset();
  mocks.start.mockReset();
  mocks.peek.mockReset();
  const view = {
    ...makeView(),
    generation: 4,
    offset: 120,
    term: { ...makeView().term, write: vi.fn() },
  };
  mocks.get.mockResolvedValue(view);
  mocks.start
    .mockResolvedValueOnce({ success: false, error: "generation-stale" })
    .mockReturnValueOnce(new Promise(() => {}));
  const mounted = render(<TerminalTab {...props} />);
  await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
  expect(mocks.start.mock.calls[0]![0]).toMatchObject({ generation: 4 });
  expect(mocks.start.mock.calls[1]![0]).toMatchObject({ generation: null });
  expect(view.offset).toBeUndefined();
  expect(mounted.queryByRole("alert")).toBeNull();
  mounted.unmount();
});

it("a chat whose workspace was deleted starts no shell and says the workspace is missing", async () => {
  mocks.get.mockReset();
  mocks.start.mockReset();
  mocks.peek.mockReset();
  mocks.get.mockResolvedValue(makeView());
  mocks.start.mockResolvedValue({ success: false, error: "workspace-deleted" });
  const mounted = render(<TerminalTab {...props} />);
  await waitFor(() =>
    expect(mounted.getByRole("alert").textContent).toBe(
      "sessions.missing.deleted"
    )
  );
  expect(mocks.start).toHaveBeenCalledOnce();
  expect(mounted.queryByText("sessions.terminal.restart")).toBeNull();
  mounted.unmount();
});
