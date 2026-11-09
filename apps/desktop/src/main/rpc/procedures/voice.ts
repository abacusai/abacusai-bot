import type { WhisperDownloadProgress } from "@abacus-ai/contract/voice";

import { impl, isType, onIpcEvents, stream } from "./impl";

export const voiceRouter = impl.voice.router({
  whisper: {
    fetch: impl.voice.whisper.fetch.handler(async ({ input, context }) => {
      const { data, ...result } =
        await context.deps.serviceHost.whisperModelService.fetchFile(input.url);
      // An ArrayBuffer has no wire form; its bytes as a Uint8Array do.
      return data == null ? result : { ...result, data: new Uint8Array(data) };
    }),
    prepare: impl.voice.whisper.prepare.handler(({ input, context }) =>
      context.deps.serviceHost.whisperModelService.prepare(input.model)
    ),
    progress: impl.voice.whisper.progress.handler(({ context, signal }) =>
      stream<WhisperDownloadProgress>({
        path: "voice.whisper.progress",
        context,
        signal,
        attach: onIpcEvents(
          context,
          isType("whisper-download-progress"),
          (event) =>
            event.type === "whisper-download-progress" ? event.progress : null
        ),
        coalesceKey: (progress) => `${progress.model}/${progress.file}`,
      })
    ),
  },
  language: impl.voice.language.handler(({ context }) =>
    context.deps.serviceHost.dictationLanguage()
  ),
  requestMicrophone: impl.voice.requestMicrophone.handler(({ context }) =>
    context.deps.host.requestMicrophoneAccess()
  ),
});
