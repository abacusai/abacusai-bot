import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { durableStorage } from "../lib/durable-storage";

interface CodeFolderState {
  currentFolder: string | null;
  recentFolders: string[];
  /** Basename of folder to show in a banner after the next agent spawn */
  pendingFolderSwitchNotice: string | null;
  /**
   * Set the active folder. By default the path is also pushed into
   * `recentFolders`. Pass `skipRecents: true` for app-managed paths that
   * shouldn't pollute the user's recents list.
   */
  setCurrentFolder: (
    path: string | null,
    opts?: { skipRecents?: boolean }
  ) => void;
  setPendingFolderSwitchNotice: (basename: string | null) => void;
  consumePendingFolderSwitchNotice: () => string | null;
  resetForLogout: () => void;
}

const MAX_RECENT_FOLDERS = 5;

export const useCodeFolderContext = create<CodeFolderState>()(
  persist(
    (set, get) => ({
      currentFolder: null,
      recentFolders: [],
      pendingFolderSwitchNotice: null,
      setPendingFolderSwitchNotice: (basename) => {
        if (get().pendingFolderSwitchNotice !== basename) {
          set({ pendingFolderSwitchNotice: basename });
        }
      },
      consumePendingFolderSwitchNotice: () => {
        const notice = get().pendingFolderSwitchNotice;
        if (notice) {
          set({ pendingFolderSwitchNotice: null });
        }
        return notice;
      },
      resetForLogout: () => {
        set({
          currentFolder: null,
          recentFolders: [],
          pendingFolderSwitchNotice: null,
        });
      },
      setCurrentFolder: (path, opts) => {
        if (path && path !== get().currentFolder) {
          if (opts?.skipRecents) {
            set({ currentFolder: path });
          } else {
            // Add to recents, removing duplicates and limiting to max
            const recents = get().recentFolders.filter((f) => f !== path);
            const newRecents = [path, ...recents].slice(0, MAX_RECENT_FOLDERS);
            set({ currentFolder: path, recentFolders: newRecents });
          }
        } else if (path === null) {
          set({ currentFolder: null });
        }
      },
    }),
    {
      name: "abacusai-bot-code-folder",
      storage: createJSONStorage(() => durableStorage),
      partialize: (state) => ({
        currentFolder: state.currentFolder,
        recentFolders: state.recentFolders,
      }),
    }
  )
);
