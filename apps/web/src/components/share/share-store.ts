import type { ShareEntry } from "@abacus-ai/contract/share";
import { Store } from "@tanstack/react-store";

/** What the shell's share dialog is showing: one file, or the list of links. */
export type ShareDialogRequest =
  | { kind: "file"; path: string; from: ShareEntry }
  | { kind: "links" };

export const shareDialogStore = new Store<ShareDialogRequest | null>(null);

/** Files that got a link while the app is open, so an offer to share one goes away. */
export const linkedPathsStore = new Store<ReadonlySet<string>>(
  new Set<string>()
);

export const requestShare = (path: string, from: ShareEntry): void =>
  shareDialogStore.setState(() => ({ kind: "file", path, from }));

export const markLinked = (path: string): void =>
  linkedPathsStore.setState((paths) => new Set<string>(paths).add(path));

export const openSharedLinks = (): void =>
  shareDialogStore.setState(() => ({ kind: "links" }));

export const closeShareDialog = (): void =>
  shareDialogStore.setState(() => null);
