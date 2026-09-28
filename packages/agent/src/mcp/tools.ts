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
import type { ConnectedMcp, McpAdvertisedTool } from "./index.js";

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
        const current = getMcp();
        const proxy =
          current.tools.find((entry) => entry.name === tool.name)?.proxy ??
          tool.proxy;

        if (proxy?.kind === "list") return describeProxiedTools(proxy, params);

        // A proxied call names the remote tool itself; everything else is the
        // tool it was registered as.
        let routeName = tool.name;
        let callArgs = params ?? {};

        if (proxy?.kind === "call") {
          const asked = String(params?.tool ?? "").trim();
          routeName = proxy.qualifiedNames.get(asked) ?? asked;
          const given = params?.arguments;
          callArgs =
            given != null && typeof given === "object" && !Array.isArray(given)
              ? (given as Record<string, unknown>)
              : {};

          if (asked.length === 0 || !current.routes.has(routeName)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `${proxy.server} has no tool called "${asked}". Its tools are: ` +
                    `${[...proxy.qualifiedNames.keys()].join(", ")}. Look one up with ${proxy.server}_tools first.`,
                },
              ],
              details: { server: proxy.server },
              isError: true,
            };
          }
        }

        const route = current.routes.get(routeName);

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
          return await callRoute(route, callArgs);
        } catch (error) {
          // A 401 mid-session is an expired token: reconnect this one server
          // and retry once before asking the person to sign in.
          if (error instanceof McpHttpError && error.status === 401) {
            const fresh = await getMcp().reconnect?.(route.client.name);
            const retry = fresh != null ? getMcp().routes.get(routeName) : null;
            if (retry != null) {
              try {
                return await callRoute(retry, callArgs);
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

        async function callRoute(
          route: {
            client: ConnectedMcp["clients"][number];
            toolName: string;
          },
          args: Record<string, unknown>
        ) {
          // Attachment params carry local paths; file content is substituted
          // here so no base64 crosses the model's context. Gateway only: any
          // other server honouring the marker could read workspace files.
          const isTrustedGateway =
            route.client.name === ATTACHMENT_TRUSTED_SERVER;
          let callParams = args;
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

/** How much of a description the bare listing shows; the full one comes with the schema. */
const LISTING_DESCRIPTION_CHARS = 160;

/**
 * Answer a `<server>_tools` call: the named tools (or those matching the
 * query) with their descriptions and schemas, or, asked for nothing in
 * particular, every tool with a line of description.
 */
const describeProxiedTools = (
  proxy: NonNullable<McpAdvertisedTool["proxy"]>,
  params: Record<string, unknown>
): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
  isError?: boolean;
} => {
  const names = Array.isArray(params?.names)
    ? params.names.filter((name): name is string => typeof name === "string")
    : [];
  const query = String(params?.query ?? "")
    .trim()
    .toLowerCase();
  const words = query.length > 0 ? query.split(/\s+/) : [];
  const tools = proxy.client.tools;

  const wanted =
    names.length > 0 || words.length > 0
      ? tools.filter(
          (tool) =>
            names.includes(tool.name) ||
            names.includes(proxy.qualifiedNames.get(tool.name) ?? "") ||
            words.some((word) =>
              `${tool.name} ${tool.description ?? ""}`
                .toLowerCase()
                .includes(word)
            )
        )
      : null;

  if (wanted == null) {
    return {
      content: [
        {
          type: "text",
          text: [
            `${proxy.server} offers ${tools.length} tools. Ask for the ones you need by name to get their schemas:`,
            "",
            ...tools.map(
              (tool) =>
                `- ${tool.name}: ${(tool.description ?? "").replace(/\s+/g, " ").slice(0, LISTING_DESCRIPTION_CHARS)}`
            ),
          ].join("\n"),
        },
      ],
      details: { server: proxy.server, count: tools.length },
    };
  }

  if (wanted.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `${proxy.server} has nothing matching that. Its tools are: ${tools.map((tool) => tool.name).join(", ")}.`,
        },
      ],
      details: { server: proxy.server },
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: wanted
          .map((tool) =>
            [
              `## ${tool.name}`,
              tool.description ?? "",
              "Input schema:",
              JSON.stringify(
                tool.inputSchema ?? { type: "object", properties: {} }
              ),
              `Run it with ${proxy.server}_call, tool "${tool.name}".`,
            ].join("\n")
          )
          .join("\n\n"),
      },
    ],
    details: { server: proxy.server, tools: wanted.map((tool) => tool.name) },
  };
};
