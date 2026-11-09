/**
 * What the dictation UI says while a Whisper model downloads: the host's
 * progress events folded per model, plus the language and "quick mode" note
 * the last clip left (`transcribe()`), so a 238 MB wait is never silent.
 */
import {
  WHISPER_BASE_MODEL_ID,
  WHISPER_SMALL_MODEL_ID,
  type WhisperDownloadProgress,
  type WhisperModelId,
} from "@abacus-ai/contract/voice";

interface ModelDownload {
  bytes: Record<string, { loaded: number; total: number }>;
  /** Never goes back when a later file joins the total. */
  percent: number;
  status: "downloading" | "ready" | "failed";
}

export interface DownloadState {
  models: Partial<Record<WhisperModelId, ModelDownload>>;
  /** The model that just became ready, until the notice is dismissed. */
  ready: WhisperModelId | null;
}

export const EMPTY_DOWNLOAD: DownloadState = { models: {}, ready: null };

export const foldDownload = (
  state: DownloadState,
  event: WhisperDownloadProgress
): DownloadState => {
  const before = state.models[event.model];
  const bytes = {
    ...before?.bytes,
    [event.file]: { loaded: event.loadedBytes, total: event.totalBytes },
  };
  const all = Object.values(bytes);
  const total = all.reduce((sum, file) => sum + file.total, 0);
  const loaded = all.reduce((sum, file) => sum + file.loaded, 0);
  const status = event.failed
    ? "failed"
    : event.modelReady
      ? "ready"
      : "downloading";
  const model: ModelDownload = {
    bytes,
    percent: Math.max(
      before?.status === "downloading" ? before.percent : 0,
      total > 0 ? Math.min(99, Math.floor((loaded / total) * 100)) : 0
    ),
    status,
  };
  return {
    models: { ...state.models, [event.model]: model },
    ready:
      status === "ready" && before?.status === "downloading"
        ? event.model
        : state.ready,
  };
};

/** The language and model choice of the clip `transcribe()` handled last. */
export interface DictationNote {
  /** Whisper code of a non-English clip, e.g. "fr". */
  language: string | null;
  /** That clip ran on base because small was not on disk yet. */
  quick: boolean;
}

export type DownloadView =
  | {
      kind: "downloading";
      percent: number;
      language: string | null;
      quick: boolean;
    }
  | { kind: "ready"; language: string | null }
  | null;

/** Small (named by language) before base (the first-ever download); null once nothing is pending. */
export const downloadView = (
  state: DownloadState,
  note: DictationNote
): DownloadView => {
  for (const id of [WHISPER_SMALL_MODEL_ID, WHISPER_BASE_MODEL_ID] as const) {
    const model = state.models[id];
    if (model?.status !== "downloading") continue;
    const small = id === WHISPER_SMALL_MODEL_ID;
    return {
      kind: "downloading",
      percent: model.percent,
      language: small ? note.language : null,
      quick: small && note.quick,
    };
  }
  if (state.ready == null) return null;
  return {
    kind: "ready",
    language: state.ready === WHISPER_SMALL_MODEL_ID ? note.language : null,
  };
};

let note: DictationNote = { language: null, quick: false };
const noteListeners = new Set<() => void>();

export const setDictationNote = (next: DictationNote): void => {
  if (next.language === note.language && next.quick === note.quick) return;
  note = next;
  for (const listener of noteListeners) listener();
};

export const subscribeDictationNote = (listener: () => void): (() => void) => {
  noteListeners.add(listener);
  return () => noteListeners.delete(listener);
};

export const dictationNote = (): DictationNote => note;
