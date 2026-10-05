import type { FileTreeNode } from "@abacus-ai/contract/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

import { MAX_LOADED_DIRECTORIES, useLazyChildren } from "./lazy-children";
it("lazy children replace invalidated directories, refresh roots without dropping open directories and isolate checkouts", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let name = "old.txt";
  const hook = renderHook(
    ({ identity, revision }) =>
      useLazyChildren(identity, revision, (directory) => ({
        queryKey: ["children", identity, directory],
        queryFn: async () =>
          [
            { kind: "file", relativePath: `${directory}/${name}` },
          ] as FileTreeNode[],
      })),
    {
      initialProps: { identity: "A", revision: 1 },
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  );
  try {
    act(() => hook.result.current.load("dir"));
    await waitFor(() =>
      expect(hook.result.current.children.map((n) => n.relativePath)).toEqual([
        "dir/old.txt",
      ])
    );
    name = "new.txt";
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["children"] });
    });
    await waitFor(() =>
      expect(hook.result.current.children.map((n) => n.relativePath)).toEqual([
        "dir/new.txt",
      ])
    );
    name = "after-root.txt";
    hook.rerender({ identity: "A", revision: 2 });
    expect(
      hook.result.current.children.map((node) => node.relativePath)
    ).toEqual(["dir/new.txt"]);
    await waitFor(() =>
      expect(
        hook.result.current.children.map((node) => node.relativePath)
      ).toEqual(["dir/after-root.txt"])
    );
    hook.rerender({ identity: "B", revision: 2 });
    expect(
      client
        .getQueryCache()
        .find({ queryKey: ["children", "B", "dir"], exact: true })
    ).toBeUndefined();
    expect(hook.result.current.children).toEqual([]);
    for (let i = 0; i < MAX_LOADED_DIRECTORIES + 5; i++)
      act(() => hook.result.current.load(`dir${i}`));
    await waitFor(() =>
      expect(hook.result.current.children).toHaveLength(MAX_LOADED_DIRECTORIES)
    );
    await waitFor(() =>
      expect(
        client.getQueryCache().findAll({ queryKey: ["children"] })
      ).toHaveLength(MAX_LOADED_DIRECTORIES)
    );
    expect(
      hook.result.current.children.some((node) =>
        node.relativePath.startsWith("dir0/")
      )
    ).toBe(false);
  } finally {
    hook.unmount();
    client.clear();
  }
});
