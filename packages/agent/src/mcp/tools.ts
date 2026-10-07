/**
 * MCP tools, as pi tools. `Type.Unsafe` wraps the server's raw JSON Schema so
 * pi can serialize it without TypeBox understanding every construct. Server
 * errors come back as error results, not throws: the model should adapt, not
 * have the turn torn down.
 */
import { Type } from "typebox";

import {
  ATTACHMENT_TRUSTED_SERVER,
  AttachmentError,
  attachmentParamNames,
  rewriteAttachmentParams,
  saveAttachmentBlocks,
} from "./attachments.js";
import { McpHttpError } from "./client.js";
import type { ConnectedMcp } from "./index.js";

interface PiToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>
  ) => Promise<{
    content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    >;
    details: unknown;
    isError?: boolean;
  }>;
}

export function buildMcpToolDefinitions(
  getMcp: () => ConnectedMcp
): PiToolDefinitionLike[] {
  return getMcp().tools.map((tool) => {
    return {
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: Type.Unsafe(tool.schema),
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        // Resolved at call time: refreshMcp replaces the ConnectedMcp, so a
        // route captured at registration would go stale.
        const route = getMcp().routes.get(tool.name);

        if (route == null) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No MCP server is connected for ${tool.name}.`,
              },
            ],
            details: {},
            isError: true,
          };
        }

        try {
          return await callRoute(route);
        } catch (error) {
          // A 401 mid-session is an expired token: reconnect this one server
          // and retry once before asking the person to sign in.
          if (error instanceof McpHttpError && error.status === 401) {
            const fresh = await getMcp().reconnect?.(route.client.name);
            const retry = fresh != null ? getMcp().routes.get(tool.name) : null;
            if (retry != null) {
              try {
                return await callRoute(retry);
              } catch (again) {
                return failure(route, again);
              }
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${tool.name} failed: ${route.client.name} needs a sign-in in the app (its session expired).`,
                },
              ],
              details: { server: route.client.name, tool: route.toolName },
              isError: true,
            };
          }
          return failure(route, error);
        }

        function failure(
          at: { client: { name: string }; toolName: string },
          error: unknown
        ) {
          if (error instanceof AttachmentError) {
            // The model can fix these (wrong path, too big).
            return {
              content: [{ type: "text" as const, text: error.message }],
              details: { server: at.client.name, tool: at.toolName },
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { server: at.client.name, tool: at.toolName },
            isError: true,
          };
        }

        async function callRoute(route: {
          client: ConnectedMcp["clients"][number];
          toolName: string;
        }) {
          // Attachment params carry local paths; file content is substituted
          // here so no base64 crosses the model's context. Gateway only: any
          // other server honouring the marker could read workspace files.
          const isTrustedGateway =
            route.client.name === ATTACHMENT_TRUSTED_SERVER;
          let callParams = params ?? {};
          const attachmentParams = isTrustedGateway
            ? attachmentParamNames(tool.schema)
            : [];
          if (attachmentParams.length > 0) {
            callParams = rewriteAttachmentParams(
              callParams,
              attachmentParams,
              process.cwd()
            );
          }

          const result = await route.client.callTool(
            route.toolName,
            callParams
          );

          // Blob resources land in the workspace; the model gets the path.
          const saved = isTrustedGateway
            ? saveAttachmentBlocks(result.blocks, process.cwd())
            : [];
          const text =
            saved.length > 0
              ? `${result.text}\n\n${saved.join("\n")}`
              : result.text;

          // The provider drops image blocks for a model that cannot see.
          const images = result.blocks.flatMap((block) =>
            block.type === "image" &&
            typeof block.data === "string" &&
            typeof block.mimeType === "string"
              ? [
                  {
                    type: "image" as const,
                    data: block.data,
                    mimeType: block.mimeType,
                  },
                ]
              : []
          );

          return {
            content: [{ type: "text" as const, text }, ...images],
            details: { server: route.client.name, tool: route.toolName },
            isError: result.isError,
          };
        }
      },
    };
  });
}

/** The slice of pi's session that decides which tools the model sees. */
interface ActiveTools {
  getActiveToolNames(): string[];
  setActiveToolsByName(toolNames: string[]): void;
}

/**
 * Makes the MCP tools the model sees exactly the ones the servers list now.
 * pi cannot unregister a tool, so a registered MCP tool its server no longer
 * lists (a connector disconnected, revoked or disabled) is deactivated, and
 * one that comes back is activated again. Takes effect from the next request;
 * returns whether anything changed.
 */
export function syncActiveMcpTools(
  session: ActiveTools,
  registered: ReadonlySet<string>,
  listed: ReadonlySet<string>
): boolean {
  const active = session.getActiveToolNames();
  const next = active.filter(
    (name) => !registered.has(name) || listed.has(name)
  );
  for (const name of registered)
    if (listed.has(name) && !next.includes(name)) next.push(name);
  if (
    next.length === active.length &&
    next.every((name) => active.includes(name))
  )
    return false;
  session.setActiveToolsByName(next);
  return true;
}

/**
 * Calls one routed MCP tool from this process's own code (a host's internal
 * tool), with its text and error flag; null when no server routes it or the
 * call failed.
 */
export function mcpToolCaller(
  getMcp: () => ConnectedMcp,
  name: string
): (
  args: Record<string, unknown>
) => Promise<{ text: string; isError: boolean } | null> {
  return async (args) => {
    const route = getMcp().routes.get(name);
    if (route == null) return null;
    try {
      const result = await route.client.callTool(route.toolName, args);
      return { text: result.text, isError: result.isError === true };
    } catch {
      return null;
    }
  };
}
