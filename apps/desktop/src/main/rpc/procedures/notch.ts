import type { NotchEvent, OpenCommand } from "#shared/contract/notch";

import type { RpcContext } from "../context";
import { forbidden } from "../errors";
import {
  impl,
  onChannel,
  requireMainRenderer,
  requireWindow,
  stream,
} from "./impl";
const controller = (context: RpcContext) => {
  if (!context.deps.notch) throw forbidden("generation");
  return context.deps.notch;
};
const requireNotch = (context: RpcContext, active = true) => {
  const id = requireWindow(context);
  if (context.windowKind !== "notch") throw forbidden("not-notch");
  if (active) controller(context).requireActive(id);
  return id;
};
export const notchRouter = impl.notch.router({
  layout: impl.notch.layout.handler(({ context }) =>
    controller(context).layout(requireNotch(context, false))
  ),
  events: impl.notch.events.handler(({ context, signal }) => {
    const id = requireNotch(context, false);
    return stream<NotchEvent>({
      path: "notch.events",
      context,
      signal,
      initial: () => controller(context).initial(id),
      attach: onChannel(context, "notch", (payload) =>
        payload.webContentsId === id ? payload.event : null
      ),
      coalesceKey: (event) =>
        event.type === "reaction"
          ? `${event.type}:${event.sessionId}`
          : event.type,
    });
  }),
  setShape: impl.notch.setShape.handler(({ context, input }) =>
    controller(context).setShape(requireNotch(context, false), input)
  ),
  visibility: impl.notch.visibility.handler(({ context, input }) =>
    controller(context).visibility(requireNotch(context), input.documentVisible)
  ),
  setInteractive: impl.notch.setInteractive.handler(({ context, input }) =>
    controller(context).interactive(requireNotch(context), input.interactive)
  ),
  focus: impl.notch.focus.handler(({ context, input }) =>
    controller(context).focus(requireNotch(context), input.focus)
  ),
  haptic: impl.notch.haptic.handler(({ context, input }) =>
    controller(context).haptic(requireNotch(context), input.key)
  ),
  openInApp: impl.notch.openInApp.handler(({ context, input }) =>
    controller(context).open(requireNotch(context), input)
  ),
  presented: impl.notch.presented.handler(({ context, input }) =>
    controller(context).presented(
      requireNotch(context),
      input.dedupeKey,
      input.documentVisible
    )
  ),
  status: impl.notch.status.handler(({ context }) => {
    requireWindow(context);
    return controller(context).status();
  }),
  preview: impl.notch.preview.handler(({ context }) => {
    requireMainRenderer(context);
    controller(context).preview();
  }),
  retry: impl.notch.retry.handler(({ context }) => {
    requireMainRenderer(context);
    return controller(context).retry();
  }),
  openCommands: impl.notch.openCommands.handler(({ context, signal }) => {
    requireMainRenderer(context);
    return stream<OpenCommand>({
      path: "notch.openCommands",
      context,
      signal,
      initial: () => controller(context).commands(),
      attach: onChannel(context, "notch-open", (command) => command),
    });
  }),
  ackOpen: impl.notch.ackOpen.handler(({ context, input }) => {
    requireMainRenderer(context);
    controller(context).ack(input.id);
  }),
});
