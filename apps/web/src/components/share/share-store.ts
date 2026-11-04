import { Store } from "@tanstack/react-store";

/** What the shell's share dialog is showing: one file, or the list of links. */
export type ShareDialogRequest =
  | { kind: "file"; path: string }
  | { kind: "links" };

export const shareDialogStore = new Store<ShareDialogRequest | null>(null);

export const requestShare = (path: string): void =>
  shareDialogStore.setState(() => ({ kind: "file", path }));

export const openSharedLinks = (): void =>
  shareDialogStore.setState(() => ({ kind: "links" }));

export const closeShareDialog = (): void =>
  shareDialogStore.setState(() => null);
