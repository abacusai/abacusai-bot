import type { DockviewApi } from "dockview-react";

const workspaces = new Map<string, DockviewApi>();
export const registerWorkspace = (scope: string, api: DockviewApi) => {
  workspaces.set(scope, api);
  return () => {
    if (workspaces.get(scope) === api) workspaces.delete(scope);
  };
};
/** Acceptance-only: uses Dockview's public API, preserving the live panes. */
export const setAuditLayout = (
  scope: string,
  layout: "single" | "horizontal" | "vertical" | "nested"
) => {
  const api = workspaces.get(scope);
  const chat = api?.getPanel("chat");
  if (!api || !chat) {
    if (layout === "single") return 0;
    throw new Error(`Workspace not mounted: ${scope}`);
  }
  const tools = api.panels.filter((panel) => panel.id !== "chat");
  for (const panel of tools)
    panel.api.moveTo({ group: chat.group, position: "center" });
  if (layout !== "single" && tools[0])
    tools[0].api.moveTo({
      group: chat.group,
      position: layout === "vertical" ? "bottom" : "right",
    });
  if (layout === "nested" && tools[1] && tools[0])
    tools[1].api.moveTo({ group: tools[0].group, position: "bottom" });
  chat.api.setActive();
  return api.groups.length;
};
