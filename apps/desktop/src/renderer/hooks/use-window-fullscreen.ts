import { useEffect, useState } from "react";

/** Tracks native fullscreen, which the DOM fullscreen APIs do not report. */
export function useWindowFullScreen(): boolean {
  const [fullScreen, setFullScreen] = useState(false);

  useEffect(() => {
    if (
      window.api?.isFullScreen == null ||
      window.api.onFullScreenChange == null
    )
      return;
    let active = true;
    void window.api.isFullScreen().then((next) => {
      if (active) setFullScreen(next);
    });
    const off = window.api.onFullScreenChange(setFullScreen);
    return () => {
      active = false;
      off();
    };
  }, []);

  return fullScreen;
}
