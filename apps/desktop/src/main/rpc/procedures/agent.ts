import { ModelUnavailableError } from "../../services/session/model-switch";
import { conflict } from "../errors";
import { impl } from "./impl";

export const agentRouter = impl.agent.router({
  feedback: impl.agent.feedback.handler(({ input, context }) =>
    context.deps.serviceHost.submitTurnFeedback(input)
  ),
  // Without overrides, the row's model and mode (spec 04 §26.4 d): the
  // legacy IPC start keeps its own defaults.
  start: impl.agent.start.handler(({ input, context }) => {
    const { serviceHost } = context.deps;
    const session = serviceHost
      .listAllAgentSessions()
      .find((entry) => entry.id === input.sessionId);
    return serviceHost.startAgentSession({
      ...input,
      ...(input.model == null &&
        session?.model != null && { model: session.model }),
      ...(input.mode == null &&
        session?.mode != null && { mode: session.mode }),
    });
  }),
  stop: impl.agent.stop.handler(({ input, context }) =>
    context.deps.serviceHost.stopAgentSession(input)
  ),
  state: impl.agent.state.handler(({ input, context }) =>
    context.deps.serviceHost.getAgentSessionState(input)
  ),
  setMode: impl.agent.setMode.handler(({ input, context }) => {
    context.deps.serviceHost.setAgentMode(input);
  }),
  setModel: impl.agent.setModel.handler(async ({ input, context }) => {
    try {
      await context.deps.serviceHost.setAgentModelChecked(input);
    } catch (error) {
      if (error instanceof ModelUnavailableError)
        throw conflict("model-unavailable", error.message);
      throw error;
    }
  }),
  reset: impl.agent.reset.handler(({ input, context }) => {
    context.deps.serviceHost.resetAgentConversation(input);
  }),
  switchConversation: impl.agent.switchConversation.handler(
    ({ input, context }) => {
      context.deps.serviceHost.switchAgentConversation(input);
    }
  ),
  respondPermission: impl.agent.respondPermission.handler(
    ({ input, context }) => {
      context.deps.serviceHost.respondAgentPermission(input);
    }
  ),
  skills: impl.agent.skills.handler(({ input, context }) => {
    context.deps.serviceHost.listAgentSkills(input);
  }),
  queue: {
    enqueue: impl.agent.queue.enqueue.handler(({ input, context }) => {
      context.deps.serviceHost.enqueueAgentMessage(input);
    }),
    dequeue: impl.agent.queue.dequeue.handler(({ input, context }) => {
      context.deps.serviceHost.dequeueAgentMessage(input);
    }),
    get: impl.agent.queue.get.handler(({ input, context }) => {
      context.deps.serviceHost.getAgentQueue(input);
    }),
    clear: impl.agent.queue.clear.handler(({ input, context }) => {
      context.deps.serviceHost.clearAgentQueue(input);
    }),
    remove: impl.agent.queue.remove.handler(({ input, context }) => {
      context.deps.serviceHost.removeAgentQueueMessage(input);
    }),
    update: impl.agent.queue.update.handler(({ input, context }) => {
      context.deps.serviceHost.updateAgentQueueMessage(input);
    }),
  },
});
