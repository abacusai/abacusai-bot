import type { WindowEvent } from "#shared/contract";

import { forbidden } from "../errors";
import { impl, onChannel, requireWindow, stream } from "./impl";

/** Scoped to the caller's own window, through the port it called on. */
export const windowRouter = impl.window.router({
  showAbout: impl.window.showAbout.handler(({ context }) => {
    requireWindow(context);
    context.deps.app.showAboutPanel();
  }),
  state: impl.window.state.handler(({ context }) => {
    const state = context.deps.windows.state(requireWindow(context));
    if (state == null) throw forbidden("The calling window is gone");
    return state;
  }),
  chrome: impl.window.chrome.handler(({ context }) => {
    const chrome = context.deps.windows.chrome(requireWindow(context));
    if (chrome == null) throw forbidden("The calling window is gone");
    return chrome;
  }),
  events: impl.window.events.handler(({ context, signal }) => {
    const webContentsId = requireWindow(context);
    return stream<WindowEvent>({
      path: "window.events",
      context,
      signal,
      attach: onChannel(context, "window", (payload) =>
        payload.webContentsId === webContentsId ? payload.event : null
      ),
      initial: () => {
        const state = context.deps.windows.state(webContentsId);
        const chrome = context.deps.windows.chrome(webContentsId);
        return [
          ...(state == null ? [] : [{ type: "state" as const, state }]),
          ...(chrome == null ? [] : [{ type: "chrome" as const, chrome }]),
        ];
      },
      // Each is a full state: the latest of each kind is all that matters.
      coalesceKey: (event) => event.type,
    });
  }),
  activity: impl.window.activity.handler(({ context }) => {
    requireWindow(context);
    context.deps.app.markRendererActivity();
  }),
  ready: impl.window.ready.handler(({ input, context }) => {
    context.deps.windows.reportReady(requireWindow(context), input);
  }),
});
