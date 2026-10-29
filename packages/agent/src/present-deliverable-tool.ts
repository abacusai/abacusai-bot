/**
 * `present_deliverable`: handing the work over when no MCP server provides it.
 * The desktop serves this over MCP, and every prompt tells the model to end
 * with this tool. Name, schema, path resolution and markdown match
 * mcp-agent-tools-server.ts, except the closing line names the primary item
 * rather than claiming a preview pane opened, since there may be none.
 */
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

import { checkLocalUrl, isLoopbackUrl } from "./deliverable-url.js";

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

/** Mirrors the desktop's host-path.ts: any Unicode space reads as a space. */
const SPACE_VARIANTS_RE = /[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000]/g;
const foldName = (name: string): string =>
  name.normalize("NFC").replace(SPACE_VARIANTS_RE, " ");

/**
 * The path that exists for the one the model named: itself, or the one entry
 * in its directory that reads the same. The model transcribes names from
 * tool output and loses the characters a person cannot see.
 */
const locate = (candidate: string): string | null => {
  try {
    if (fs.existsSync(candidate)) return candidate;
    const wanted = foldName(path.basename(candidate));
    const matches = fs
      .readdirSync(path.dirname(candidate))
      .filter((entry) => foldName(entry) === wanted);
    return matches.length === 1
      ? path.join(path.dirname(candidate), matches[0]!)
      : null;
  } catch {
    return null;
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
      "listing what the user asked for, most important first.",
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
      "the only way to put the file back on screen: describing it, or rendering its pages",
      "into the chat, does not show it. Presenting the same file twice is cheap and safe.",
      "",
      "A URL on this computer is opened first: one that does not answer is not presented,",
      "and the result says why. Get the app running (serve) before you call it done.",
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
                  "the workspace directory. Files must exist and URLs must answer: this reports the ones that do not.",
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
          "At least one item is required, each with a path or an http(s) URL.",
          true
        );
      }

      const valid: Array<{ label: string; target: string; isUrl: boolean }> =
        [];
      const missing: string[] = [];
      const dead: string[] = [];
      const notes: string[] = [];

      for (const entry of rawItems) {
        const item = (
          typeof entry === "object" && entry != null ? entry : {}
        ) as Record<string, unknown>;
        const raw = String(item.path ?? "").trim();

        if (raw.length === 0) continue;

        const isUrl = /^https?:\/\//i.test(raw);
        // A served URL cannot be stat'ed; a path is located on disk, so the
        // item carries the file's real name and a bad path never reports as
        // shown.
        const target = isUrl ? raw : locate(resolve(raw));
        if (target == null) {
          missing.push(resolve(raw));
          continue;
        }

        // A local URL nobody answers is a broken app, not a deliverable.
        if (isLoopbackUrl(raw)) {
          const check = await checkLocalUrl(raw);
          if (!check.ok) {
            dead.push(`${raw}: ${check.reason}`);
            continue;
          }
          notes.push(`${raw} answered (HTTP ${check.status}).`);
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
        const detail = [...missing, ...dead];

        return text(
          `Nothing could be presented: none of those exist or answer. Check the paths, and get the server running.${detail.length > 0 ? `\n\n${detail.join("\n")}` : ""}`,
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
      if (dead.length > 0) {
        lines.push(
          "",
          "Not presented, because nothing answered there:",
          ...dead.map((line) => `- ${line}`)
        );
      }
      if (notes.length > 0) lines.push("", "Checked:", ...notes);
      lines.push(
        "",
        ...valid.map((item) => `${ARTIFACT_PATH_MARKER} ${item.target}`)
      );

      return text(lines.join("\n"));
    },
  };
}
