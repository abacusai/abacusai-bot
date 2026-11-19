import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type { FileTreeNode, FileTreeRootSnapshot } from "../contracts";
import type { ConversationKey } from "../conversation-scope";
import type { PptxDeck } from "../pptx";
import { mutation, query, subscription } from "./base";
import { CheckoutRefSchema, type CheckoutKey } from "./checkout";
import { ConversationKeySchema, NoInput } from "./ids";

export const UPLOAD_LIMITS = {
  fileBytes: 256 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  fileCount: 1000,
} as const;

export type FilesEvent =
  /**
   * A checkout's tree root changed: re-read `treeRoot`/`treeChildren` for it.
   * `checkoutKey` names the checkout (spec 04 §26.4 a): the active
   * workspace's primary checkout for the legacy event, or a checkout with a
   * live `git.watch`. Absent only when no workspace is active.
   */
  | { type: "tree-root-changed"; checkoutKey?: CheckoutKey }
  /**
   * Show a path in the pane of the conversation that presented it. `id`
   * names main's stored target: the pane answers `previewHandled` with it.
   */
  | {
      type: "preview-open";
      path: string;
      conversationKey?: ConversationKey;
      id?: string;
    };

/** A conversation's stored `present_deliverable` target, not yet shown. */
export interface PendingPreview {
  id: string;
  path: string;
}

export interface DirectoryListing {
  root: string;
  path: string;
  entries: Array<{
    name: string;
    path: string;
    kind: "directory" | "file";
    sizeBytes: number;
  }>;
}

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

/**
 * The tree, search, rename and trash procedures act on the legacy active
 * workspace without `checkout` (the old renderer's behaviour), and on the
 * named checkout with it (spec 04 §26.4 a): the session's worktree when it
 * has one, else the workspace's primary checkout. Every path is resolved,
 * symlinks included, and must stay inside it (`FORBIDDEN {reason:
 * "outside"}`).
 */
export const files = {
  listDirectory: query
    .input(v.object({ path: v.optional(v.string()) }))
    .output(type<DirectoryListing>()),
  /** A finished document printed again in another look (no model call). */
  relook: mutation
    .input(
      v.object({
        path: v.string(),
        look: v.optional(
          v.picklist([
            "classic",
            "editorial",
            "bold",
            "minimal",
            "warm",
            "midnight",
          ])
        ),
        /** A design of the document's type, or "classic" for its own layout. */
        design: v.optional(v.pipe(v.string(), v.maxLength(64))),
      })
    )
    .output(type<{ path: string }>()),
  /** The designs a finished document can switch to (its type's). */
  designs: query
    .input(v.object({ path: v.string() }))
    .output(
      type<{ type: string; designs: Array<{ id: string; name: string }> }>()
    ),
  mkdir: mutation
    .input(
      v.object({ path: v.string(), name: v.pipe(v.string(), v.nonEmpty()) })
    )
    .output(type<{ path: string }>()),
  treeRoot: query
    .input(v.optional(v.object({ checkout: v.optional(CheckoutRefSchema) })))
    .output(type<FileTreeRootSnapshot>()),
  treeChildren: query
    .input(
      v.object({
        directoryPath: v.string(),
        checkout: v.optional(CheckoutRefSchema),
      })
    )
    .output(type<FileTreeNode[]>()),
  search: query
    .input(
      v.object({ query: v.string(), checkout: v.optional(CheckoutRefSchema) })
    )
    .output(type<FileSearchResult>()),
  /** `RenameLocalFileResult` unwrapped. */
  rename: mutation
    .input(
      v.object({
        fromPath: v.pipe(v.string(), v.nonEmpty()),
        toPath: v.pipe(v.string(), v.nonEmpty()),
        checkout: v.optional(CheckoutRefSchema),
      })
    )
    .output(type<void>()),
  /** `TrashLocalFileResult` unwrapped. */
  trash: mutation
    .input(
      v.object({
        filePath: v.pipe(v.string(), v.nonEmpty()),
        checkout: v.optional(CheckoutRefSchema),
      })
    )
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
  /**
   * The conversation's latest `present_deliverable` target that no pane has
   * shown yet: a pane reads it when it mounts (after a reload too).
   */
  pendingPreview: query
    .input(v.object({ conversationKey: ConversationKeySchema }))
    .output(type<PendingPreview | null>()),
  /** The pane took the stored target (`shown`, or declined it): main forgets it. */
  previewHandled: mutation
    .input(
      v.object({
        conversationKey: ConversationKeySchema,
        id: v.pipe(v.string(), v.nonEmpty()),
        shown: v.boolean(),
      })
    )
    .output(type<void>()),
  events: subscription.input(NoInput).output(eventIterator(type<FilesEvent>())),
};
