/**
 * The tool widget maps (spec 02 §5.2): `Proxy` objects that answer every
 * name (tool names are open: MCP tools, extensions), so a missing widget
 * never renders nothing (F7). Sessions get step rows; bots show no inline
 * rows, only an approval card at the tool's position when a descriptor
 * joins it (§5.4 bot skin, §6.2).
 */
import type { ToolProps } from "@tanstack/ai-react/ui";
import { useEffect, type ComponentType } from "react";

import { descriptorFor, useThreadStore } from "../../store/selectors";
import { toolKey } from "../../store/thread-store";
import { useChatView, useSubagentScope } from "../context";
import { PermissionCard } from "../permissions/permission-card";
import { expanderFor, ToolLine } from "./tool-line";

type Widget = ComponentType<ToolProps<unknown>>;

const lineFor = (name: string): Widget => {
  const expander = expanderFor(name);
  const Line = ({ part, result }: ToolProps<unknown>) => (
    <ToolLine part={part} result={result} expander={expander} />
  );
  Line.displayName = `ToolLine(${name})`;
  return Line;
};

const KNOWN = ["bash", "read", "batch_file_read", "write", "edit", "ast_edit", "batch_edit", "notebook_edit", "todo"];
const KNOWN_TOOL_WIDGETS: Record<string, Widget> = Object.fromEntries(
  KNOWN.map((name) => [name, lineFor(name)])
);

/** Any other name: `ToolLine` with the generic (or browser) expander. */
const GenericLine = ({ part, result }: ToolProps<unknown>) => (
  <ToolLine part={part} result={result} />
);

export const sessionToolWidgets = new Proxy(KNOWN_TOOL_WIDGETS, {
  get: (known, name) => (typeof name === "string" ? (known[name] ?? GenericLine) : undefined),
}) as Record<string, Widget>;

/** Bots: the inline approval card of the canvas BotApproval board. */
const BotToolSlot = ({ part }: ToolProps<unknown>) => {
  const { session, inline } = useChatView();
  const scope = useSubagentScope();
  const descriptor = useThreadStore(session, (state) => descriptorFor(state, scope, part.id));
  const key = toolKey(scope, part.id);
  const joined = descriptor != null;
  useEffect(() => (joined ? inline.register(key) : undefined), [joined, inline, key]);
  return descriptor == null ? null : <PermissionCard descriptor={descriptor} />;
};

export const botToolWidgets = new Proxy({} as Record<string, Widget>, {
  get: (_known, name) => (typeof name === "string" ? BotToolSlot : undefined),
}) as Record<string, Widget>;
