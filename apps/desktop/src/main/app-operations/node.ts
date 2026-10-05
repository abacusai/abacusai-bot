import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { parsePptx } from "@abacus-ai/contract/pptx/parser";

import { resolvePastedFilePath } from "../pasted-temp-files";
import { WORKSPACE_DIR_NAME } from "../paths";
import type { AppOperations } from "../rpc/deps";
import { logStore } from "../services/diagnostics/log-store";
import { ZipArchive } from "../services/pptx/zip";
import { openHostFile } from "../services/workspace/host-path";

/** Extension allow-list for the agent-image reader below. */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_TEXT_BYTES_DEFAULT = 524288; // 512 KB
// Embedded images come back as base64 data URLs, so the payload lands
// several times larger than the file; 200 MB wedged the renderer.
const MAX_PPTX_BYTES = 60 * 1024 * 1024; // 60 MB

export const nodeFileOperations: Pick<
  AppOperations,
  | "savePastedTempFiles"
  | "appendLogs"
  | "readImageAsDataUrl"
  | "readFileAsText"
  | "readPptx"
> = {
  async savePastedTempFiles(baseFolder, files) {
    try {
      if (typeof baseFolder !== "string" || baseFolder.length === 0) {
        return { success: false, error: "workspace path required" };
      }
      const tempDir = path.join(baseFolder, WORKSPACE_DIR_NAME, "temp");
      mkdirSync(tempDir, { recursive: true });
      // Self-ignoring: the user's repo does not ignore .abacusai-bot/, and
      // untracked attachments would read as "the agent created these".
      await fs
        .writeFile(path.join(tempDir, ".gitignore"), "*\n")
        .catch(() => {});
      // Renderer-supplied names; resolvePastedFilePath keeps writes inside.
      const paths = files.map((file) =>
        resolvePastedFilePath(tempDir, file.name)
      );
      await Promise.all(
        files.map((file, i) => fs.writeFile(paths[i], Buffer.from(file.data)))
      );
      return { success: true, dir: tempDir, paths };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
  appendLogs(lines) {
    if (!Array.isArray(lines)) return;

    for (const line of lines) {
      if (typeof line === "string") logStore().append("renderer", line);
    }
  },
  async readImageAsDataUrl(args) {
    try {
      const filePath = args?.filePath;
      const hostRoot = args?.hostRoot;
      if (!filePath || !hostRoot) {
        return {
          success: false,
          error: "filePath and hostRoot are required",
        };
      }

      const ext = path.extname(filePath).toLowerCase();
      const mimeType = IMAGE_MIME[ext];
      if (!mimeType) {
        return { success: false, error: "unsupported-extension" };
      }

      const file = await openHostFile(filePath, hostRoot);
      if (file.ok === false) return { success: false, error: file.error };
      const { realFile, stat } = file;
      if (stat.size > MAX_IMAGE_BYTES) {
        return {
          success: false,
          error: "too-large",
          sizeBytes: stat.size,
        };
      }

      const buf = await fs.readFile(realFile);
      const dataUrl = `data:${mimeType};base64,${buf.toString("base64")}`;
      return { success: true, dataUrl, mimeType, sizeBytes: stat.size };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
  async readFileAsText(args) {
    try {
      const filePath = args?.filePath;
      const hostRoot = args?.hostRoot;
      if (!filePath || !hostRoot) {
        return {
          success: false,
          error: "filePath and hostRoot are required",
        };
      }

      const maxBytes = args?.maxBytes ?? MAX_TEXT_BYTES_DEFAULT;

      const file = await openHostFile(filePath, hostRoot);
      if (file.ok === false) return { success: false, error: file.error };
      const { realFile, stat } = file;

      const sizeBytes = stat.size;

      // A null byte in the first 8KB marks a binary file.
      const fd = await fs.open(realFile, "r");
      try {
        const probe = Buffer.alloc(Math.min(8192, sizeBytes));
        await fd.read(probe, 0, probe.length, 0);
        if (probe.includes(0)) {
          return { success: false, error: "binary-file", sizeBytes };
        }
      } finally {
        await fd.close();
      }

      const truncated = sizeBytes > maxBytes;
      let content: string;
      if (truncated) {
        const buf = Buffer.alloc(maxBytes);
        const fd2 = await fs.open(realFile, "r");
        try {
          await fd2.read(buf, 0, maxBytes, 0);
        } finally {
          await fd2.close();
        }
        content = buf.toString("utf8");
      } else {
        content = await fs.readFile(realFile, "utf8");
      }

      return { success: true, content, sizeBytes, truncated };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
  async readPptx(args) {
    try {
      const filePath = args?.filePath;
      const hostRoot = args?.hostRoot;
      if (!filePath || !hostRoot) {
        return {
          success: false,
          error: "filePath and hostRoot are required",
        };
      }

      const file = await openHostFile(filePath, hostRoot);
      if (file.ok === false) return { success: false, error: file.error };
      const { realFile, stat } = file;
      if (stat.size > MAX_PPTX_BYTES) {
        return {
          success: false,
          error: "too-large",
          sizeBytes: stat.size,
        };
      }

      const buf = await fs.readFile(realFile);
      const deck = parsePptx(ZipArchive.open(buf));
      return { success: true, deck, sizeBytes: stat.size };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
