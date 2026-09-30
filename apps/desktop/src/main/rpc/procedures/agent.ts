import { impl } from "./impl";

export const agentRouter = impl.agent.router({
  feedback: impl.agent.feedback.handler(({ input, context }) =>
    context.deps.serviceHost.submitTurnFeedback(input)
  ),
  start: impl.agent.start.handler(({ input, context }) =>
    context.deps.serviceHost.startAgentSession(input)
  ),
  stop: impl.agent.stop.handler(({ input, context }) =>
    context.deps.serviceHost.stopAgentSession(input)
  ),
  state: impl.agent.state.handler(({ input, context }) =>
    context.deps.serviceHost.getAgentSessionState(input)
  ),
  setMode: impl.agent.setMode.handler(({ input, context }) => {
    context.deps.serviceHost.setAgentMode(input);
  }),
  setModel: impl.agent.setModel.handler(({ input, context }) => {
    context.deps.serviceHost.setAgentModel(input);
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
