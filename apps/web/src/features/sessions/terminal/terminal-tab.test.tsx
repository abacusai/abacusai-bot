import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import { act, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  get: vi.fn(),
  hide: vi.fn(),
}));
vi.mock("../data/queries", () => {
  const transport = {
    client: { terminal: { start: mocks.start, hide: mocks.hide } },
  };
  return { useSessionsTransport: () => transport };
});
vi.mock("./terminal-registry", () => ({ getTerminalView: mocks.get }));
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
