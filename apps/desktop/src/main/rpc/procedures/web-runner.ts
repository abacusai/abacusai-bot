import type { WebRunnerState } from "#shared/contract";

import { forbidden } from "../errors";
import { impl } from "./impl";

const OFF: WebRunnerState = { enabled: false, status: "off", views: 0 };

export const webRunnerRouter = impl.webRunner.router({
  state: impl.webRunner.state.handler(
    ({ context }) => context.deps.webRunner?.state() ?? OFF
  ),
  setEnabled: impl.webRunner.setEnabled.handler(({ input, context }) => {
    const runner = context.deps.webRunner;
    if (runner == null) throw forbidden("Not available here");
    return runner.setEnabled(input.enabled);
  }),
});
