import { useEffect, useRef, useState } from "react";

import { getTransport, type Transport } from "#next/data/transport";

import { VoiceOperation, type VoiceState } from "./operation";
import { startRecording, decodeForWhisper } from "./recorder";
import { configureVoice, transcribe } from "./whisper";
export const useDictation = (
  transport: Transport | null,
  sessionId: string,
  onTranscript: (text: string) => void
) => {
  const [state, setState] = useState<VoiceState>("idle");
  const [level, setLevel] = useState(0);
  const callback = useRef(onTranscript);
  callback.current = onTranscript;
  const operation = useRef<VoiceOperation | null>(null);
  useEffect(() => {
    if (!transport) return;
    configureVoice(transport);
    const value = new VoiceOperation({
      permission: () => transport.client.voice.requestMicrophone({}),
      record: (signal) => startRecording(setLevel, signal),
      transcribe: async (clip) =>
        transcribe(await decodeForWhisper(clip.audio)),
      transcript: (text) => callback.current(text),
      state: setState,
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
    start: () => operation.current?.start(),
    end: () => operation.current?.end(),
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
