/**
 * `present_deliverable` — handing the work over, from the CLI. The desktop
 * serves this over MCP; the CLI has no MCP server, and every prompt tells the
 * model to end with this tool. Name, schema, path resolution and markdown match
 * mcp-agent-tools-server.ts, except the closing line names the primary item
 * rather than claiming a preview pane opened, since a terminal has none.
 */
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

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

export const PRESENT_DELIVERABLE_TOOL_NAME = "present_deliverable";

/** Mirrors the desktop's shared/deliverables.ts: one line per accepted item. */
const ARTIFACT_PATH_MARKER = "[artifact]";

const text = (body: string, isError = false) => ({
  content: [{ type: "text" as const, text: body }],
  details: null,
  ...(isError ? { isError: true } : {}),
});

/**
 * Escaped the way the desktop's renderer decodes it, so a space or `#` survives
 * as a link; pathToFileURL also keeps `C:` from parsing as the URL's authority.
 */
const fileUrl = (absolutePath: string): string =>
  pathToFileURL(absolutePath).href;

const exists = (candidate: string): boolean => {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
};

export function buildPresentDeliverableTool(
  workspacePath: () => string
): PiToolDefinitionLike {
  const resolve = (raw: string): string =>
    path.isAbsolute(raw) ? raw : path.resolve(workspacePath(), raw);

  return {
    name: PRESENT_DELIVERABLE_TOOL_NAME,
    label: PRESENT_DELIVERABLE_TOOL_NAME,
    description: [
      "Hand the finished work over. Call this at the end of a turn that produced files,",
      "listing what the user asked for — most important first.",
      "",
      "The items become clickable links in the chat and are filed as artifacts, and the",
      "first one opens in the preview pane. Naming a path in prose does none of that, and",
      "a file written with `bash` is not recorded anywhere unless it is declared here.",
      "",
      "List the deliverables, not the workings: the report, not the six scratch files it",
      "was assembled from.",
      "",
      "Call it again whenever the user asks to see, show, open, or look at something you",
      "already made. The pane may have been closed or the app restarted since, and this is",
      "the only way to put the file back on screen — describing it, or rendering its pages",
      "into the chat, does not show it. Presenting the same file twice is cheap and safe.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description:
            "The deliverables, most important first. The first one is the primary result.",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Path to the file, or an http(s) URL (a served app). A relative path resolves against " +
                  "the workspace directory. Files must exist — this reports the ones that do not.",
              },
              label: {
                type: "string",
                description:
                  'Short human name, e.g. "Q3 deck (PDF)". Defaults to the file name.',
              },
            },
            required: ["path"],
          },
        },
        summary: {
          type: "string",
          description: "One line about what was produced.",
        },
      },
      required: ["items"],
    },
    execute: async (_toolCallId, params) => {
      const rawItems = Array.isArray(params.items) ? params.items : [];

      if (rawItems.length === 0) {
        return text(
          "At least one item is required — each with a path or an http(s) URL.",
          true
        );
      }

      const valid: Array<{ label: string; target: string; isUrl: boolean }> =
        [];
      const missing: string[] = [];

      for (const entry of rawItems) {
        const item = (
          typeof entry === "object" && entry != null ? entry : {}
        ) as Record<string, unknown>;
        const raw = String(item.path ?? "").trim();

        if (raw.length === 0) continue;

        const isUrl = /^https?:\/\//i.test(raw);
        const target = isUrl ? raw : resolve(raw);

        // A served URL cannot be stat'ed; a path can, and is checked so a bad
        // path never reports as shown.
        if (!isUrl && !exists(target)) {
          missing.push(target);
          continue;
        }

        const label = String(item.label ?? "").trim();

        valid.push({
          label:
            label.length > 0 ? label : isUrl ? target : path.basename(target),
          target,
          isUrl,
        });
      }

      if (valid.length === 0) {
        const detail = missing.length > 0 ? `\n\n${missing.join("\n")}` : "";

        return text(
          `Nothing could be presented — none of those exist. Check the paths.${detail}`,
          true
        );
      }

      const first = valid[0]!;
      const summary = String(params.summary ?? "").trim();
      const lines = [
        ...(summary.length > 0 ? [summary, ""] : []),
        ...valid.map(
          (item) =>
            `- [${item.label}](${item.isUrl ? item.target : fileUrl(item.target)})`
        ),
        "",
        `${first.label} is the primary deliverable.`,
      ];

      if (missing.length > 0) {
        lines.push(
          "",
          `Not presented, because there is no file at these paths: ${missing.join(", ")}`
        );
      }
      lines.push(
        "",
        ...valid.map((item) => `${ARTIFACT_PATH_MARKER} ${item.target}`)
      );

      return text(lines.join("\n"));
    },
  };
}
