import { create } from "zustand";

interface LocalModelDialogState {
  open: boolean;
  /** What to do with the model once it is ready to use, as `local/<id>`. */
  onReady: ((model: string) => void) | null;
  show: (onReady?: (model: string) => void) => void;
  hide: () => void;
}

/**
 * One dialog for the whole app, opened from wherever the way on is a local
 * model: the out-of-credits cards, the sidebar, the picker. The opener says
 * what happens once the model is ready — the chat that ran dry resumes on it;
 * the settings page only wants it installed.
 */
export const useLocalModelDialogStore = create<LocalModelDialogState>()(
  (set) => ({
    open: false,
    onReady: null,
    show: (onReady) => set({ open: true, onReady: onReady ?? null }),
    hide: () => set({ open: false, onReady: null }),
  })
);
