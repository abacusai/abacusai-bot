import type { FileTreeOptions, FileTree } from "@pierre/trees";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const retained = new WeakMap<FileTree, FileTreeOptions>();
let model: FileTree;
vi.mock("@pierre/trees/react", async (original) => {
  const real = await original<typeof import("@pierre/trees/react")>();
  return {
    ...real,
    useFileTree: (options: FileTreeOptions) => {
      const result = real.useFileTree(options);
      model = result.model;
      if (!retained.has(model)) retained.set(model, options);
      return result;
    },
    // jsdom has no virtualized shadow-DOM layout. Dispatch the model's retained
    // rename callback, exactly as the library's rename controller does.
    FileTree: ({ model }: { model: FileTree }) => (
      <button
        onClick={() => {
          const rename = retained.get(model)!.renaming;
          if (rename && typeof rename === "object")
            rename.onRename?.({
              sourcePath: "dir/file.txt",
              destinationPath: "dir/renamed.txt",
            } as never);
        }}
      >
        Rename
      </button>
    ),
  };
});
import { FileTreeView } from "./index";

it("renames in B after A → B through a mounted router and recreates checkout models", async () => {
  const rename = vi.fn();
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/sessions/$sessionId",
    component: function SessionFiles() {
      const { sessionId } = useParams({ strict: false });
      return (
        <FileTreeView
          checkoutIdentity={sessionId}
          paths={["dir/", "dir/file.txt"]}
          onSelect={() => {}}
          onOpen={() => {}}
          onRename={(from, to) => rename(sessionId, from, to)}
        />
      );
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/sessions/A"] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
  const a = model;
  await act(async () => {
    await router.navigate({
      to: "/sessions/$sessionId",
      params: { sessionId: "B" },
    });
  });
  fireEvent.click(screen.getByText("Rename"));
  expect(rename).toHaveBeenCalledExactlyOnceWith(
    "B",
    "dir/file.txt",
    "dir/renamed.txt"
  );
  expect(model).not.toBe(a);
});
it("reads current callbacks in the same checkout and preserves expansion for equal and changed topology", () => {
  const old = vi.fn(),
    current = vi.fn();
  const props = {
    checkoutIdentity: "B",
    paths: ["dir/", "dir/file.txt"],
    onSelect: () => {},
    onOpen: () => {},
    onRename: old,
  };
  const view = render(<FileTreeView {...props} />);
  const item = model.getItem("dir/")!;
  if ("expand" in item) item.expand();
  const reset = vi.spyOn(model, "resetPaths");
  view.rerender(
    <FileTreeView {...props} paths={[...props.paths]} onRename={current} />
  );
  expect(reset).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Rename"));
  expect(current).toHaveBeenCalledOnce();
  expect(old).not.toHaveBeenCalled();
  view.rerender(
    <FileTreeView {...props} paths={[...props.paths, "dir/new.txt"]} />
  );
  const expanded = model.getItem("dir/")!;
  expect("isExpanded" in expanded && expanded.isExpanded()).toBe(true);
});
