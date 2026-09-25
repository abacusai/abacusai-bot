/**
 * `serve`: putting a page the agent wrote on a URL. The desktop also serves
 * this over MCP; registering it here means an agent spawned without that server
 * can still open a page, since `bash` runs a command to completion and kills a
 * dev server the moment it reports ready. Name, actions, schema and output
 * match the MCP version in mcp-agent-tools-server.ts.
 */
import path from "path";

import { listServed, serveDirectory, stopDirectory } from "./static-server.js";

interface PiToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
    isError?: boolean;
  }>;
}

export const SERVE_TOOL_NAME = "serve";

const text = (body: string, isError = false) => ({
  content: [{ type: "text" as const, text: body }],
  details: null,
  ...(isError ? { isError: true } : {}),
});

export function buildServeTool(
  workspacePath: () => string
): PiToolDefinitionLike {
  const resolve = (raw: string): string =>
    path.isAbsolute(raw) ? raw : path.resolve(workspacePath(), raw);

  return {
    name: SERVE_TOOL_NAME,
    label: SERVE_TOOL_NAME,
    description: [
      "Serve a directory over http and get back a URL, so a web page you wrote can actually",
      "be opened. Static files only: html, css, js, images.",
      "",
      "Use it the moment you have written a page the user is meant to look at. `bash` cannot",
      "do this: it runs a command to completion, so a dev server started there is killed as",
      "soon as it reports being ready, and the URL answers nothing.",
      "",
      "Then hand the URL to present_deliverable: that is what records it. A URL in prose is",
      "not recorded.",
      "",
      "Actions:",
      '  "start": serve a directory (directory). Serving it again returns the same URL.',
      '  "stop":  stop serving one (directory).',
      '  "list":  what is being served right now.',
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "stop", "list"],
          description: "What to do.",
        },
        directory: {
          type: "string",
          description:
            "The directory to serve. A relative path resolves against the workspace directory.",
        },
      },
      required: ["action"],
    },
    execute: async (_toolCallId, params) => {
      const action = String(params.action ?? "").trim();
      const directory = String(params.directory ?? "").trim();

      try {
        if (action === "list") {
          const served = listServed();

          return text(
            served.length === 0
              ? "Nothing is being served."
              : JSON.stringify(served, null, 2)
          );
        }

        if (directory.length === 0)
          return text("A directory is required.", true);

        if (action === "stop") {
          return text(
            stopDirectory(resolve(directory))
              ? "Stopped."
              : "That directory was not being served."
          );
        }

        if (action === "start") {
          const served = await serveDirectory(resolve(directory));

          return text(
            `Serving ${served.directory} at ${served.url}\n\n` +
              `Hand it over: present_deliverable with ${served.url}`
          );
        }

        return text(`Unknown action "${action}".`, true);
      } catch (error) {
        return text(
          `Could not serve that directory: ${(error as Error)?.message ?? "unknown error"}`,
          true
        );
      }
    },
  };
}
