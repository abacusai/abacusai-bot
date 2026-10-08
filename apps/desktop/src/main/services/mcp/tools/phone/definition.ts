import type { ToolDefinition, ToolHost, ToolResult } from "../definition";

/**
 * A tool as the WhatsApp chat sees it: its own description, schema and
 * result words, over the same engine the app's tool calls. The phone never
 * reads an app tool's text: a tool reaches it only through a definition here
 * (see ./index.ts and the phone tools test).
 */
export interface PhoneToolDefinition extends Pick<
  ToolDefinition,
  "name" | "toolsets" | "ready"
> {
  surface: "phone";
  description: string;
  inputSchema: Record<string, unknown>;
  run: (
    host: ToolHost,
    args: Record<string, unknown>,
    callerSession?: string
  ) => ToolResult | Promise<ToolResult>;
}
