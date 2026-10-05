import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
vi.mock("../data/queries", () => ({
  useSessionsTransport: () => ({}),
  useGitState: () => null,
  useCheckoutIdentity: () => "w:primary:/repo",
}));
vi.mock("#renderer/components/diff-view", () => ({
  DiffView: ({ patch }: { patch: string }) => <pre>{patch}</pre>,
}));
import { initI18n } from "#renderer/lib/i18n";

import { FullDiffDialog } from "./full-diff-dialog";
it("a mounted dialog refetches when switching tool edits to the same path", async () => {
  await initI18n();
  const qc = new QueryClient();
  const resolveA = vi.fn(async () => ({
    state: "ready" as const,
    original: "before",
    final: "edit-A",
  }));
  const resolveB = vi.fn(async () => ({
    state: "ready" as const,
    original: "before",
    final: "edit-B",
  }));
  const props = {
    workspaceId: "w",
    sessionId: "s",
    root: "/repo",
    path: "same.txt",
    source: "tool" as const,
    onClose: () => {},
    onGit: () => {},
  };
  const view = render(
    <QueryClientProvider client={qc}>
      <FullDiffDialog {...props} toolKey="tool-A" resolveTool={resolveA} />
    </QueryClientProvider>
  );
  expect(await screen.findByText(/\+edit-A/)).toBeTruthy();
  view.rerender(
    <QueryClientProvider client={qc}>
      <FullDiffDialog {...props} toolKey="tool-B" resolveTool={resolveB} />
    </QueryClientProvider>
  );
  expect(await screen.findByText(/\+edit-B/)).toBeTruthy();
  expect(resolveB).toHaveBeenCalledOnce();
  view.unmount();
  qc.clear();
});
