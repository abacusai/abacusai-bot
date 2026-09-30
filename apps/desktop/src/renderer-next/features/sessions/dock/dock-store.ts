export interface DockLeaf {
  kind: "leaf";
  id: string;
  tabs: string[];
  active: string | null;
}
export interface DockSplit {
  kind: "split";
  id: string;
  orientation: "horizontal" | "vertical";
  children: DockNode[];
}
export type DockNode = DockLeaf | DockSplit;
export type DockAction =
  | {
      type: "move";
      tab: string;
      target: string;
      edge?: "left" | "right" | "top" | "bottom";
      id: string;
      before?: string;
    }
  | { type: "close"; tab: string }
  | { type: "focus"; tab: string };
export const dockLeaves = (node: DockNode): DockLeaf[] =>
  node.kind === "leaf" ? [node] : node.children.flatMap(dockLeaves);
export const dockMinimum = (
  node: DockNode,
  axis: "width" | "height"
): number => {
  if (node.kind === "leaf") return 240;
  const sizes = node.children.map((child) => dockMinimum(child, axis));
  const summed = (axis === "width") === (node.orientation === "horizontal");
  return summed
    ? sizes.reduce((a, b) => a + b, 0) + 8 * (sizes.length - 1)
    : Math.max(...sizes);
};
const clean = (node: DockNode): DockNode | null => {
  if (node.kind === "leaf")
    return node.tabs.length
      ? {
          ...node,
          active: node.tabs.includes(node.active ?? "")
            ? node.active
            : node.tabs[0]!,
        }
      : null;
  const children = node.children
    .map(clean)
    .filter((n): n is DockNode => n != null);
  return children.length === 1
    ? children[0]!
    : children.length
      ? { ...node, children }
      : null;
};
const mapLeaves = (
  node: DockNode,
  fn: (leaf: DockLeaf) => DockNode
): DockNode =>
  node.kind === "leaf"
    ? fn(node)
    : { ...node, children: node.children.map((n) => mapLeaves(n, fn)) };
const depth = (node: DockNode): number =>
  node.kind === "leaf" ? 0 : 1 + Math.max(...node.children.map(depth));
export const dockReducer = (tree: DockNode, action: DockAction): DockNode => {
  if (action.tab === "chat") return tree;
  if (action.type === "focus")
    return mapLeaves(tree, (l) =>
      l.tabs.includes(action.tab) ? { ...l, active: action.tab } : l
    );
  if (action.type === "close")
    return (
      clean(
        mapLeaves(tree, (l) => ({
          ...l,
          tabs: l.tabs.filter((t) => t !== action.tab),
        }))
      ) ?? { kind: "leaf", id: tree.id, tabs: [], active: null }
    );
  const target = dockLeaves(tree).find((l) => l.id === action.target);
  if (!target) return tree;
  // Joining preserves the target, even when it temporarily loses its only tab.
  const stripped = mapLeaves(tree, (l) => ({
    ...l,
    tabs: l.tabs.filter((t) => t !== action.tab),
  }));
  const result = clean(
    mapLeaves(stripped, (l) => {
      if (l.id !== action.target) return l;
      if (!action.edge)
        return {
          ...l,
          tabs:
            action.before && l.tabs.includes(action.before)
              ? [
                  ...l.tabs.slice(0, l.tabs.indexOf(action.before)),
                  action.tab,
                  ...l.tabs.slice(l.tabs.indexOf(action.before)),
                ]
              : [...l.tabs, action.tab],
          active: action.tab,
        };
      const next: DockLeaf = {
        kind: "leaf",
        id: action.id,
        tabs: [action.tab],
        active: action.tab,
      };
      return {
        kind: "split",
        id: `split-${action.id}`,
        orientation:
          action.edge === "left" || action.edge === "right"
            ? "horizontal"
            : "vertical",
        children:
          action.edge === "left" || action.edge === "top"
            ? [next, l]
            : [l, next],
      };
    })
  );
  if (!result || dockLeaves(result).length > 3 || depth(result) > 2)
    return tree;
  // Horizontal splits occur only at the root: never more than two columns.
  if (
    result.kind === "split" &&
    result.orientation === "horizontal" &&
    result.children.length > 2
  )
    return tree;
  if (
    result.kind === "split" &&
    result.children.some(
      (c) => c.kind === "split" && c.orientation === "horizontal"
    )
  )
    return tree;
  return result;
};
export const foldedDock = (
  tree: DockNode,
  width: number,
  height: number,
  focused: string | null
): DockNode => {
  if (
    width >= dockMinimum(tree, "width") &&
    height >= dockMinimum(tree, "height")
  )
    return tree;
  const tabs = dockLeaves(tree).flatMap((l) => l.tabs);
  return {
    kind: "leaf",
    id: "folded",
    tabs,
    active: tabs.includes(focused ?? "") ? focused : (tabs[0] ?? null),
  };
};
