import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { followNotices } from "#renderer/data/queries/notices";
import { getTransport, type Transport } from "#renderer/data/transport";

import {
  dictationNote,
  downloadView,
  EMPTY_DOWNLOAD,
  foldDownload,
  subscribeDictationNote,
} from "./download-status";
import { VoiceOperation, type VoiceState } from "./operation";
import { startRecording, decodeForWhisper } from "./recorder";
import { configureVoice, prepareDictation, transcribe } from "./whisper";
/** How long "ready" stays up after a download lands. */
const READY_NOTICE_MS = 5_000;

export const useDictation = (
  transport: Transport | null,
  sessionId: string,
  onTranscript: (text: string) => void
) => {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<"microphone" | "transcription" | null>(
    null
  );
  const [level, setLevel] = useState(0);
  const callback = useRef(onTranscript);
  useEffect(() => {
    callback.current = onTranscript;
  }, [onTranscript]);
  const [download, setDownload] = useState(EMPTY_DOWNLOAD);
  const note = useSyncExternalStore(subscribeDictationNote, dictationNote);
  useEffect(() => {
    if (!transport) return;
    const abort = new AbortController();
    void followNotices(
      transport,
      ({ signal }) => transport.client.voice.whisper.progress({}, { signal }),
      (event) => setDownload((state) => foldDownload(state, event)),
      abort.signal
    );
    return () => abort.abort();
  }, [transport]);
  useEffect(() => {
    if (download.ready == null) return;
    const dismiss = setTimeout(() => {
      setDownload((state) => ({ ...state, ready: null }));
    }, READY_NOTICE_MS);
    return () => clearTimeout(dismiss);
  }, [download.ready]);
  const operation = useRef<VoiceOperation | null>(null);
  useEffect(() => {
    if (!transport) return;
    configureVoice(transport);
    const value = new VoiceOperation({
      permission: () => transport.client.voice.requestMicrophone({}),
      record: (signal) => {
        void prepareDictation();
        return startRecording(setLevel, signal);
      },
      transcribe: async (clip) =>
        transcribe(await decodeForWhisper(clip.audio)),
      transcript: (text) => callback.current(text),
      state: (value) => {
        if (value === "starting" || value === "idle") setError(null);
        setState(value);
      },
      error: setError,
    });
    operation.current = value;
    return () => {
      operation.current = null;
      void value.dispose();
    };
  }, [transport, sessionId]);
  return {
    state,
    level,
    error,
    /** What to say while a model downloads; null when nothing is pending. */
    download: downloadView(download, note),
    start: () => operation.current?.start() ?? Promise.resolve(),
    end: () => operation.current?.end() ?? Promise.resolve(),
    cancel: () => operation.current?.cancel(),
  };
};

export const useConnectedDictation = (
  sessionId: string,
  onTranscript: (text: string) => void
) => {
  const [transport, setTransport] = useState<Transport | null>(null);
  useEffect(() => {
    let live = true;
    void getTransport()
      .then((value) => {
        if (live) setTransport(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return useDictation(transport, sessionId, onTranscript);
};
