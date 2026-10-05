/**
 * The permission tray's selected chip per thread (spec 02 §6.2): answering
 * one selects the next remaining; a "needs you" row's Show selects its own.
 */
import { Store } from "@tanstack/react-store";

export const permissionSelection = new Store<Record<string, string | null>>({});

export const selectPermission = (threadId: string, id: string | null): void =>
  permissionSelection.setState((state) => ({ ...state, [threadId]: id }));
