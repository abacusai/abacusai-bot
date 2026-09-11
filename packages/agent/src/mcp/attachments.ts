/**
 * Attachments across the desktop/gateway seam. The connector gateway runs
 * tools in a kernel with none of the user's files, so the seam carries content,
 * not paths: outbound, params stamped `x_abacus_attachment` are rewritten from
 * local paths to {filename, content_base64}; inbound, blob-resource blocks are
 * written into the workspace. Paths are read only from inside the workspace,
 * because a connector call is egress and MCP tools have no ask channel.
 */
import fs from "node:fs";
import path from "node:path";

/** Matches ATTACHMENT_SCHEMA_MARKER on the gateway. */
const ATTACHMENT_MARKER = "x_abacus_attachment";

/**
 * The only server whose tools get the attachment treatment; must match
 * ABACUS_CONNECTORS_SERVER_NAME in the desktop's shared/contracts.ts (this
 * package cannot import from the app tree). Without the gate any configured
 * MCP server could stamp the marker and have workspace files read into its
 * calls.
 */
export const ATTACHMENT_TRUSTED_SERVER = "abacus-connectors";

/** Matches the gateway's inbound cap; checked here to save the round trip. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Where inbound files land, relative to the workspace. */
const ATTACHMENTS_DIR = "attachments";

/** The parameters a tool takes as attachments, per the gateway's marker. */
export function attachmentParamNames(schema: unknown): string[] {
  const properties = (
    schema as { properties?: Record<string, Record<string, unknown>> } | null
  )?.properties;

  if (properties == null) return [];

  return Object.entries(properties)
    .filter(([, prop]) => prop?.[ATTACHMENT_MARKER] === true)
    .map(([name]) => name);
}

export class AttachmentError extends Error {}

interface UploadPayload {
  filename: string;
  content_base64: string;
}

/**
 * Resolve one attachment path and prove it stays inside the workspace.
 * Checked on realpaths on both sides: a symlink inside the workspace pointing
 * at ~/.ssh would pass a lexical check.
 */
const containedPath = (workspace: string, raw: string): string => {
  let workspaceReal: string;
  let real: string;
  try {
    workspaceReal = fs.realpathSync(workspace);
    real = fs.realpathSync(path.resolve(workspaceReal, raw));
  } catch {
    throw new AttachmentError(
      `Attachment file not found: ${raw}. Pass the path of an existing file in the workspace.`
    );
  }

  const relative = path.relative(workspaceReal, real);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AttachmentError(
      `Attachment path ${raw} is outside the workspace. Only files inside the ` +
        `workspace can be sent — copy the file into the workspace first, then retry.`
    );
  }

  return real;
};

/**
 * One local path to the wire shape, or a clear error the model can act on.
 * `sizes` accumulates toward the per-call cap across every file in the call.
 */
const toPayload = (
  workspace: string,
  raw: string,
  sizes: { total: number }
): UploadPayload => {
  const resolved = containedPath(workspace, raw);

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new AttachmentError(`Attachment path is not a file: ${raw}.`);
  }

  sizes.total += stat.size;
  if (sizes.total > MAX_UPLOAD_BYTES) {
    throw new AttachmentError(
      `Attachments exceed ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB per call. Send fewer or smaller files.`
    );
  }

  return {
    filename: path.basename(resolved),
    content_base64: fs.readFileSync(resolved).toString("base64"),
  };
};

/**
 * Rewrite the attachment-typed params of one call from local paths to
 * {filename, content_base64}. Non-string values pass through: a wrong shape
 * is the server schema's problem to report.
 */
export function rewriteAttachmentParams(
  params: Record<string, unknown>,
  paramNames: string[],
  workspace: string
): Record<string, unknown> {
  if (paramNames.length === 0) return params;

  const sizes = { total: 0 };
  const next = { ...params };

  for (const name of paramNames) {
    const value = next[name];

    if (typeof value === "string") {
      next[name] = toPayload(workspace, value, sizes);
    } else if (Array.isArray(value)) {
      next[name] = value.map((item) =>
        typeof item === "string" ? toPayload(workspace, item, sizes) : item
      );
    }
  }

  return next;
}

/**
 * A server-supplied filename reduced to something that cannot navigate: both
 * separators (\`basename\` leaves backslashes intact on POSIX), control
 * characters and leading dots go; length-capped with the extension kept.
 */
const sanitizeFilename = (raw: string): string => {
  const lastSegment = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = [...lastSegment]
    .filter((character) => character.charCodeAt(0) >= 0x20)
    .join("")
    .replace(/^\.+/, "")
    .trim();

  if (cleaned.length === 0) return "attachment";
  if (cleaned.length <= 128) return cleaned;

  const extension = path.extname(cleaned).slice(0, 16);

  return `${cleaned.slice(0, 128 - extension.length)}${extension}`;
};

/** A name that cannot escape the attachments directory or collide silently. */
const availableName = (directory: string, filename: string): string => {
  const base = sanitizeFilename(filename);

  let candidate = base;
  for (
    let attempt = 1;
    fs.existsSync(path.join(directory, candidate));
    attempt += 1
  ) {
    const extension = path.extname(base);
    candidate = `${path.basename(base, extension)}-${attempt}${extension}`;
  }

  return candidate;
};

/**
 * Write the blob-resource blocks a tool returned into the workspace, one line
 * per file for the model. A blob that fails to write becomes an error line,
 * not a failed call: the textual result already arrived.
 */
export function saveAttachmentBlocks(
  blocks: Array<Record<string, unknown>>,
  workspace: string
): string[] {
  const lines: string[] = [];

  for (const block of blocks) {
    if (block.type !== "resource") continue;
    const resource = block.resource as
      | { name?: unknown; blob?: unknown; mimeType?: unknown }
      | undefined;
    if (typeof resource?.blob !== "string") continue;

    const filename =
      typeof resource.name === "string" && resource.name.length > 0
        ? resource.name
        : "attachment";

    try {
      const directory = path.join(workspace, ATTACHMENTS_DIR);
      fs.mkdirSync(directory, { recursive: true });
      const finalName = availableName(directory, filename);
      fs.writeFileSync(
        path.join(directory, finalName),
        Buffer.from(resource.blob, "base64")
      );
      lines.push(
        `Saved attachment ${finalName} to ${path.join(ATTACHMENTS_DIR, finalName)}`
      );
    } catch (error) {
      lines.push(
        `Could not save attachment ${filename}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return lines;
}
