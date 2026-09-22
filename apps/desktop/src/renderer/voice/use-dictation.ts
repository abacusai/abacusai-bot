import { useCallback, useEffect, useRef, useState } from "react";

import type { WhisperDownloadProgress } from "#shared/voice";

import {
  decodeForWhisper,
  MicrophoneError,
  startRecording,
  type MicError,
  type RecorderHandle,
} from "./recorder";
import { transcribe, whisper } from "./whisper";

export type DictationPhase = "idle" | "recording" | "transcribing";

export interface DictationState {
  phase: DictationPhase;
  /** 0..1 microphone level while recording. */
  level: number;
  /** Model download in flight, so the first use can say why it waits. */
  download: WhisperDownloadProgress | null;
  error: MicError | "transcription-failed" | null;
}

/**
 * Push-to-talk dictation: one press records, the next stops and hands the
 * transcript to `onText`. The model loads on the first stop, so the first
 * clip waits for a download the button reports.
 */
export const useDictation = (
  onText: (text: string) => void
): DictationState & {
  toggle: () => void;
  cancel: () => void;
} => {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [level, setLevel] = useState(0);
  const [download, setDownload] = useState<WhisperDownloadProgress | null>(
    null
  );
  const [error, setError] = useState<DictationState["error"]>(null);
  const recorder = useRef<RecorderHandle | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(
    () =>
      window.api.agent.onEvent((event) => {
        if (event.type !== "whisper-download-progress") return;
        setDownload(event.progress.done ? null : event.progress);
      }),
    []
  );

  useEffect(() => () => recorder.current?.cancel(), []);

  const start = useCallback(async () => {
    setError(null);
    const permitted = await window.api.agent.requestMicrophoneAccess();
    if (!permitted) {
      setError("permission-denied");
      return;
    }
    try {
      recorder.current = await startRecording(setLevel);
      setPhase("recording");
      // Start fetching the model while they talk, so the stop is quicker.
      void whisper().catch(() => undefined);
    } catch (failure) {
      setError(
        failure instanceof MicrophoneError ? failure.reason : "unsupported"
      );
    }
  }, []);

  const stop = useCallback(async () => {
    const handle = recorder.current;
    recorder.current = null;
    if (handle == null) return;
    setPhase("transcribing");
    setLevel(0);
    try {
      const recording = await handle.stop();
      if (recording != null && recording.durationMs > 300) {
        const text = await transcribe(await decodeForWhisper(recording.audio));
        if (text.length > 0) onTextRef.current(text);
      }
    } catch (failure) {
      // The tooltip says it failed; the console says why, for a bug report.
      console.error("[dictation] transcription failed", failure);
      setError("transcription-failed");
    } finally {
      setPhase("idle");
      setDownload(null);
    }
  }, []);

  const toggle = useCallback(() => {
    if (phase === "recording") void stop();
    else if (phase === "idle") void start();
  }, [phase, start, stop]);

  const cancel = useCallback(() => {
    recorder.current?.cancel();
    recorder.current = null;
    setPhase("idle");
    setLevel(0);
  }, []);

  return { phase, level, download, error, toggle, cancel };
};
