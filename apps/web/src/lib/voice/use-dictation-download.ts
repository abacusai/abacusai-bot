/**
 * The dictation download notice's data: the host's Whisper progress stream,
 * folded and re-rendered only when what the notice says changes (the stream
 * sends one event per chunk), plus the last clip's language note.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { followNotices } from "#renderer/data/queries/notices";
import { getTransport } from "#renderer/data/transport";

import {
  dictationNote,
  type DownloadState,
  type DownloadView,
  downloadView,
  EMPTY_DOWNLOAD,
  foldDownload,
  subscribeDictationNote,
} from "./download-status";

/** How long "ready" stays up after a download lands. */
const READY_NOTICE_MS = 5_000;

/** What the notice shows: per-model percent and status, and the ready model. */
const visible = (state: DownloadState): string =>
  JSON.stringify([
    state.ready,
    Object.entries(state.models).map(([id, model]) => [
      id,
      model?.percent,
      model?.status,
    ]),
  ]);

export const useDictationDownload = (): DownloadView => {
  const [shown, setShown] = useState(EMPTY_DOWNLOAD);
  const latest = useRef(EMPTY_DOWNLOAD);
  const note = useSyncExternalStore(subscribeDictationNote, dictationNote);
  useEffect(() => {
    const abort = new AbortController();
    void getTransport()
      .then((transport) =>
        followNotices(
          transport,
          ({ signal }) =>
            transport.client.voice.whisper.progress({}, { signal }),
          (event) => {
            const next = foldDownload(latest.current, event);
            const changed = visible(next) !== visible(latest.current);
            latest.current = next;
            if (changed) setShown(next);
          },
          abort.signal
        )
      )
      .catch(() => undefined);
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (shown.ready == null) return;
    const dismiss = setTimeout(() => {
      latest.current = { ...latest.current, ready: null };
      setShown(latest.current);
    }, READY_NOTICE_MS);
    return () => clearTimeout(dismiss);
  }, [shown.ready]);
  return downloadView(shown, note);
};
