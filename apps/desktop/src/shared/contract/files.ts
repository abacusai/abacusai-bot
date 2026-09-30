import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type { FileTreeNode, FileTreeRootSnapshot } from "../contracts";
import type { ConversationKey } from "../conversation-scope";
import type { PptxDeck } from "../pptx";
import { mutation, query, subscription } from "./base";
import { NoInput } from "./ids";

export type FilesEvent =
  /** The active workspace's tree root changed: re-read `treeRoot`/`treeChildren`. */
  | { type: "tree-root-changed" }
  /** Show a path in the pane of the conversation that presented it. */
  | { type: "preview-open"; path: string; conversationKey?: ConversationKey };

export interface FileSearchResult {
  items: Array<{
    relativePath: string;
    fileName: string;
    kind: "file" | "directory";
  }>;
}

const HostFileInput = v.object({
  filePath: v.pipe(v.string(), v.nonEmpty()),
  hostRoot: v.pipe(v.string(), v.nonEmpty()),
});

export const files = {
  treeRoot: query.input(NoInput).output(type<FileTreeRootSnapshot>()),
  treeChildren: query
    .input(v.object({ directoryPath: v.string() }))
    .output(type<FileTreeNode[]>()),
  search: query
    .input(v.object({ query: v.string() }))
    .output(type<FileSearchResult>()),
  /** `RenameLocalFileResult` unwrapped. */
  rename: mutation
    .input(
      v.object({
        fromPath: v.pipe(v.string(), v.nonEmpty()),
        toPath: v.pipe(v.string(), v.nonEmpty()),
      })
    )
    .output(type<void>()),
  /** `TrashLocalFileResult` unwrapped. */
  trash: mutation
    .input(v.object({ filePath: v.pipe(v.string(), v.nonEmpty()) }))
    .output(type<void>()),
  /**
   * Pasted or dropped attachments, written under
   * `<baseFolder>/.abacusai-bot/temp/` exactly as the legacy handler does.
   */
  savePastedTemp: mutation
    .input(
      v.object({
        baseFolder: v.pipe(v.string(), v.nonEmpty()),
        files: v.array(
          v.object({ name: v.string(), data: v.instance(Uint8Array) })
        ),
      })
    )
    .output(type<{ dir: string; paths: string[] }>()),
  readImageAsDataUrl: query
    .input(HostFileInput)
    .output(type<{ dataUrl: string; mimeType: string; sizeBytes: number }>()),
  readText: query
    .input(
      v.object({
        filePath: v.pipe(v.string(), v.nonEmpty()),
        hostRoot: v.pipe(v.string(), v.nonEmpty()),
        maxBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      })
    )
    .output(type<{ content: string; sizeBytes: number; truncated: boolean }>()),
  readPptx: query
    .input(HostFileInput)
    .output(type<{ deck: PptxDeck; sizeBytes: number }>()),
  events: subscription.input(NoInput).output(eventIterator(type<FilesEvent>())),
};
