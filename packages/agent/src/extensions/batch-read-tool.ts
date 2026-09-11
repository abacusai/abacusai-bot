import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Reading several files in one call, one turn instead of one per file. The
 * byte budget is shared across the batch rather than per file (twenty files
 * at `read`'s ceiling would bury the context window), files that do not fit
 * are named, and one bad path is reported in place rather than failing the
 * batch.
 */
import {
  DEFAULT_MAX_BYTES,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Not a safety limit (the byte budget is): a model asking for a hundred files
 * is told to narrow the question rather than handed ninety "did not fit" lines.
 */
const MAX_FILES = 20;

/** Same ceiling one `read` gets: a batch saves turns, not context. */
const BATCH_MAX_BYTES = DEFAULT_MAX_BYTES;

/** Lines any single file may contribute, so one long file cannot crowd out the rest. */
const PER_FILE_MAX_LINES = 500;

const batchReadSchema = Type.Object({
  paths: Type.Array(Type.String(), {
    description:
      `Files to read, at most ${MAX_FILES}. Each is read from the start; ` +
      `use read with offset/limit for a specific region of one file.`,
  }),
});

interface FileOutcome {
  path: string;
  text: string;
  read: boolean;
}

/** Read one file, reporting a problem as content rather than throwing. */
function readOne(
  filePath: string,
  cwd: string,
  bytesLeft: number
): FileOutcome {
  const abs = path.resolve(cwd, filePath);

  let raw: string;
  try {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      return {
        path: filePath,
        text: "[not read: this is a directory]",
        read: false,
      };
    }
    raw = fs.readFileSync(abs, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      return {
        path: filePath,
        text: "[not read: does not exist]",
        read: false,
      };
    return {
      path: filePath,
      text: `[not read: ${(error as Error).message}]`,
      read: false,
    };
  }

  if (raw.includes("\u0000")) {
    return { path: filePath, text: "[not read: binary file]", read: false };
  }

  if (raw === "") {
    return { path: filePath, text: "[empty file]", read: true };
  }

  const truncation = truncateHead(raw, {
    maxLines: PER_FILE_MAX_LINES,
    maxBytes: bytesLeft,
  });

  if (truncation.firstLineExceedsLimit) {
    return {
      path: filePath,
      text: `[not read: its first line alone exceeds the remaining budget. Use read on this file by itself.]`,
      read: false,
    };
  }

  if (!truncation.truncated) {
    return { path: filePath, text: truncation.content, read: true };
  }

  return {
    path: filePath,
    text:
      `${truncation.content}\n\n[Showing lines 1-${truncation.outputLines} of ${truncation.totalLines}. ` +
      `Use read with offset=${truncation.outputLines + 1} to continue.]`,
    read: true,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "batch_file_read",
    label: "Batch Read",
    description:
      `Read several files in one call, up to ${MAX_FILES}. ` +
      "Use this whenever you already know you want more than one file — it costs one turn instead of one per file. " +
      "Each file is read from the start and the whole batch shares one output budget, so a file that does not " +
      "fit is named rather than returned. For a specific region of a single file, or for an image, use read.",
    parameters: batchReadSchema,
    promptSnippet: "Read several files in one call",
    promptGuidelines: [
      "When you want more than one file, use batch_file_read once instead of read several times",
      "Use read for one file, for a region of a file (offset/limit), or for an image",
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.paths.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No paths supplied. Pass at least one path.",
            },
          ],
          isError: true,
          details: undefined,
        };
      }

      if (params.paths.length > MAX_FILES) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `${params.paths.length} files is more than batch_file_read returns at once ` +
                `(limit ${MAX_FILES}). Ask for the ones you need first.`,
            },
          ],
          isError: true,
          details: undefined,
        };
      }

      // The same path twice would spend budget twice for nothing.
      const seen = new Set<string>();
      const unique = params.paths.filter((p) => {
        const key = path.resolve(ctx.cwd, p);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const sections: string[] = [];
      const skipped: string[] = [];
      let bytesLeft = BATCH_MAX_BYTES;
      let filesRead = 0;

      for (const filePath of unique) {
        // Budget is spent in request order, not on an arbitrary subset.
        if (bytesLeft <= 0) {
          skipped.push(filePath);
          continue;
        }

        const outcome = readOne(filePath, ctx.cwd, bytesLeft);
        sections.push(`===== ${outcome.path} =====\n${outcome.text}`);
        if (outcome.read) {
          filesRead++;
          bytesLeft -= Buffer.byteLength(outcome.text, "utf8");
        }
      }

      if (skipped.length > 0) {
        sections.push(
          `===== not read =====\n` +
            `The output budget ran out before ${skipped.join(", ")}. ` +
            `Call batch_file_read again for those.`
        );
      }

      return {
        content: [{ type: "text" as const, text: sections.join("\n\n") }],
        details: {
          filesRead,
          filesRequested: unique.length,
          skipped: skipped.length,
        },
      };
    },
  });
}
