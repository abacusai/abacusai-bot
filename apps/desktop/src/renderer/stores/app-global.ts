import { create } from "zustand";

// App-wide state no feature store owns. Prefer a focused store over growing it.
interface AppGlobalState {
  /** Used to shorten displayed paths. */
  homeDir: string;
  setHomeDir: (homeDir: string) => void;

  /** A prompt pushed into the composer from elsewhere; the composer consumes and clears it. */
  pendingPrompt: string | null;
  setPendingPrompt: (prompt: string | null) => void;
  /** With `pendingPrompt`, the composer submits it immediately. */
  pendingPromptAutoSend: boolean;
  setPendingPromptAutoSend: (value: boolean) => void;
}

export const useGlobalContext = create<AppGlobalState>()((set, get) => ({
  homeDir: "",
  setHomeDir: (homeDir) => {
    if (get().homeDir !== homeDir) set({ homeDir });
  },

  pendingPrompt: null,
  setPendingPrompt: (prompt) => {
    if (get().pendingPrompt !== prompt) set({ pendingPrompt: prompt });
  },
  pendingPromptAutoSend: false,
  setPendingPromptAutoSend: (value) => {
    if (get().pendingPromptAutoSend !== value)
      set({ pendingPromptAutoSend: value });
  },
}));
