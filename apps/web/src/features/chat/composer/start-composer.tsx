import { useState } from "react";

import {
  ChatViewProvider,
  createInlineRegistry,
  type ComposerConfig,
} from "../kit/context";
import type { ChatRuntime } from "../runtime/runtime";
import { ThreadComposer } from "./composer";
export const StartComposer = ({
  threadId,
  runtime,
  config,
  context,
}: {
  threadId: string;
  runtime: ChatRuntime;
  config: ComposerConfig;
  context?: React.ReactNode;
}) => {
  const [inline] = useState(createInlineRegistry);
  return (
    <ChatViewProvider
      value={{
        threadId,
        runtime,
        session: runtime.session(threadId),
        skin: "session",
        composer: { ...config, preStart: true, sharedElement: true },
        slots: { composerContext: context },
        workspaceRoot: config.attachmentsBase,
        focused: true,
        notchEnabled: false,
        inline,
      }}
    >
      <ThreadComposer />
    </ChatViewProvider>
  );
};
