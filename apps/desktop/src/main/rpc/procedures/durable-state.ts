import { impl } from "./impl";

/** The old renderer's durable state, from the same store its IPC uses. */
export const durableStateRouter = impl.durableState.router({
  snapshot: impl.durableState.snapshot.handler(({ context }) =>
    context.deps.rendererState.snapshot()
  ),
  set: impl.durableState.set.handler(({ input, context }) => {
    context.deps.rendererState.set(input.key, input.value);
  }),
  clear: impl.durableState.clear.handler(({ context }) => {
    context.deps.rendererState.clear();
  }),
});
